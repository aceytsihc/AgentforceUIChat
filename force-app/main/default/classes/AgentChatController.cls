// --- START OF FILE AgentChatController.cls ---
/**
 * @description Controller for the Agentforce Chat LWC.
 * Handles Einstein AI Agent session management, message sending/receiving,
 * and OAuth authentication using Client Credentials flow.
 */
public without sharing class AgentChatController {

    // Einstein AI Agent API Endpoint
    private static final String API_ENDPOINT = 'https://api.salesforce.com/einstein/ai-agent/v1';

    // OAuth Token Endpoint - dynamically uses the org's domain
    private static String AUTH_ENDPOINT {
        get {
            // Use org's domain directly instead of login/test salesforce endpoints
            // Ensures compatibility across different org types (prod, sandbox)
            return URL.getOrgDomainUrl().toExternalForm() + '/services/oauth2/token';
        }
    }

    // Simple in-memory cache for the access token to minimize auth requests
    // Note: For multi-server environments, a Platform Cache or Custom Setting might be more robust.
    private static String cachedAccessToken;
    private static Long tokenExpiration = 0; // Stored as Unix timestamp (seconds)

    // Sequence ID tracking per session
    private static Map<String,Integer> seqIds = new Map<String,Integer>();

    // Default callout timeout
    private static final Integer CALLOUT_TIMEOUT_MS_AUTH = 30000; // 30 seconds for Auth
    private static final Integer CALLOUT_TIMEOUT_MS_API = 120000; // 120 seconds for Agent API

    /**
     * @description Returns the current Salesforce org's base domain URL. Used for instanceConfig.
     * @return String The org's domain URL (e.g., https://yourdomain.my.salesforce.com)
     */
    @AuraEnabled(cacheable=true)
    public static String getOrgDomain() {
        try {
            return URL.getOrgDomainUrl().toExternalForm();
        } catch (Exception e) {
            System.debug('Error getting Org Domain: ' + e.getMessage());
            throw new AuraHandledException('Could not determine Org Domain URL.');
        }
    }

    /**
     * @description Initializes a new session with the Einstein AI Agent.
     * @param agentId The ID of the Einstein AI Agent Bot.
     * @param consumerKey The Consumer Key from the Connected App configured for Client Credentials flow.
     * @param consumerSecret The Consumer Secret from the Connected App.
     * @return String The newly created Session ID.
     */
    @AuraEnabled(cacheable=false)
    public static String initializeAgentSession(String agentId, String consumerKey, String consumerSecret) {
        System.debug('Starting initializeAgentSession for agentId: ' + agentId);

        // Input validation
        if (String.isBlank(agentId)) {
            System.debug('Validation Error: Agent ID is blank.');
            throw new AuraHandledException('Agent ID cannot be blank.');
        }
        if (String.isBlank(consumerKey) || String.isBlank(consumerSecret)) {
            System.debug('Validation Error: Consumer Key or Secret is blank.');
            throw new AuraHandledException('Consumer Key and Consumer Secret are required for authentication.');
        }

        // Sanitize inputs (trim whitespace)
        consumerKey = consumerKey.trim();
        consumerSecret = consumerSecret.trim();
        agentId = agentId.trim(); // Also trim agentId

        try {
            // 1. Obtain OAuth access token
            String accessToken = getAccessToken(consumerKey, consumerSecret);
            if (String.isBlank(accessToken)) {
                // getAccessToken throws its own specific exception
                throw new AuraHandledException('Failed to obtain access token. Check previous logs.');
            }
            System.debug('Access token obtained successfully.');

            // 2. Prepare the API request to create a session
            String endpoint = API_ENDPOINT + '/agents/' + agentId + '/sessions';
            System.debug('Calling Session Init endpoint: ' + endpoint);

            HttpRequest req = new HttpRequest();
            req.setEndpoint(endpoint);
            req.setMethod('POST');
            req.setHeader('Content-Type', 'application/json');
            req.setHeader('Authorization', 'Bearer ' + accessToken);
            req.setTimeout(CALLOUT_TIMEOUT_MS_API); // Use defined timeout

            // Construct the request payload
            // Using bypassUser=true for automated agent interaction without specific user context mapping
            Map<String, Object> payload = new Map<String, Object>{
                'externalSessionKey'    => generateUUID(), // Unique key for this session attempt
                'instanceConfig'        => new Map<String, Object>{ 'endpoint' => URL.getOrgDomainUrl().toExternalForm() },
                'streamingCapabilities' => new Map<String, Object>{ 'chunkTypes' => new List<String>{ 'Text' } }, // Adjust if streaming other types
                'bypassUser'            => true
            };
            String requestBody = JSON.serialize(payload);
            req.setBody(requestBody);
            System.debug('Session Init Request Payload: ' + requestBody);

            // 3. Send the request
            HttpResponse res = new Http().send(req);
            System.debug('Session Init Response Status: ' + res.getStatusCode() + ' ' + res.getStatus());
            System.debug('Session Init Response Body: ' + res.getBody());

            // 4. Process the response
            // Successful session creation typically returns 201 Created
            if (res.getStatusCode() == 200 || res.getStatusCode() == 201) {
                Map<String, Object> result = (Map<String, Object>)JSON.deserializeUntyped(res.getBody());
                String sessionId = (String)result.get('sessionId');
                if (String.isBlank(sessionId)) {
                    System.debug('Error: Session ID not found in successful response body.');
                    throw new AuraHandledException('API returned success status but no sessionId was found in the response.');
                }
                System.debug('Session initialized successfully. Session ID: ' + sessionId);
                return sessionId; // Return the session ID to the LWC
            } else {
                // Handle API errors
                String errorDetails = 'Status: ' + res.getStatusCode() + ', StatusText: ' + res.getStatus() + ', Body: ' + res.getBody();
                System.debug('Session Init API call failed: ' + errorDetails);
                // Attempt to parse a more specific error message from the body
                 String parsedErrorMessage = parseErrorMessageFromBody(res.getBody(), 'Session initialization failed');
                throw new AuraHandledException(parsedErrorMessage + ' (Status: ' + res.getStatusCode() + ')');
            }
        } catch (Exception e) {
             // Catch specific AuraHandledExceptions to avoid re-wrapping
             if (e instanceof AuraHandledException) {
                 throw e;
             }
            // Catch general exceptions (e.g., CalloutException)
            String errorMsg = 'Exception during initializeAgentSession: Type=' + e.getTypeName() + ', Msg=' + e.getMessage() + ', Line=' + e.getLineNumber();
            System.debug(errorMsg);
            System.debug('Stack trace: ' + e.getStackTraceString());
            // Provide a user-friendly message, potentially check for common issues
            String userFriendlyError = 'Error initializing agent session: ' + e.getMessage();
            if (e instanceof System.CalloutException && e.getMessage().contains('Unauthorized endpoint')) {
                 userFriendlyError = 'Could not connect to the Einstein API. Please ensure the Remote Site Setting "Einstein_API" (URL: ' + API_ENDPOINT + ') is active or a corresponding Named Credential exists.';
            }
            throw new AuraHandledException(userFriendlyError);
        }
    }

    /**
     * @description Sends a message to the agent session and retrieves the response.
     * @param sessionId The active agent session ID.
     * @param message The user's message text.
     * @param consumerKey The Consumer Key for authentication.
     * @param consumerSecret The Consumer Secret for authentication.
     * @return String The agent's response message text (can include HTML).
     */
    @AuraEnabled(cacheable=false)
    public static String getAgentRecommendation(String sessionId, String message, String consumerKey, String consumerSecret) {
        System.debug('Starting getAgentRecommendation for sessionId: ' + sessionId);

        // Input validation
        if (String.isBlank(sessionId) || String.isBlank(message)) {
            System.debug('Validation Error: Session ID or message is blank.');
            throw new AuraHandledException('Session ID and message cannot be blank to get agent recommendation.');
        }
         if (String.isBlank(consumerKey) || String.isBlank(consumerSecret)) {
            System.debug('Validation Error: Consumer Key or Secret is blank.');
            throw new AuraHandledException('Consumer Key and Consumer Secret are required for authentication.');
        }

        // Sanitize inputs
        consumerKey = consumerKey.trim();
        consumerSecret = consumerSecret.trim();
        sessionId = sessionId.trim();
        // message can contain anything, no trim needed here unless specific requirements exist

        try {
            // 1. Obtain OAuth access token
            String accessToken = getAccessToken(consumerKey, consumerSecret);
            if (String.isBlank(accessToken)) {
                throw new AuraHandledException('Failed to obtain access token. Check previous logs.');
            }
             System.debug('Access token obtained successfully.');

            // 2. Prepare the API request to send a message
            Integer sequenceId = incrementSequence(sessionId); // Get and increment sequence ID for this session
            String endpoint = API_ENDPOINT + '/sessions/' + sessionId + '/messages';
            System.debug('Calling Send Message endpoint: ' + endpoint);

            HttpRequest req = new HttpRequest();
            req.setEndpoint(endpoint);
            req.setMethod('POST');
            req.setHeader('Content-Type', 'application/json');
            req.setHeader('Authorization', 'Bearer ' + accessToken);
            req.setTimeout(CALLOUT_TIMEOUT_MS_API); // Use defined timeout

            // Construct the message payload
            Map<String, Object> messagePayload = new Map<String, Object>{
                'message'   => new Map<String, Object>{
                    'sequenceId' => sequenceId,
                    'type' => 'Text', // Assuming text messages
                    'text' => message
                },
                'variables' => new List<Object>() // Add variables if needed for the agent
            };
            String requestBody = JSON.serialize(messagePayload);
            req.setBody(requestBody);
             System.debug('Send Message Request Payload (Text Redacted): ' + requestBody.replace(message, '[MESSAGE REDACTED]'));

            // 3. Send the request
            HttpResponse res = new Http().send(req);
            System.debug('Send Message Response Status: ' + res.getStatusCode() + ' ' + res.getStatus());
            System.debug('Send Message Response Body: ' + res.getBody());

            // 4. Process the response
            if (res.getStatusCode() == 200) {
                Map<String, Object> result = (Map<String, Object>)JSON.deserializeUntyped(res.getBody());
                if (result.containsKey('messages') && result.get('messages') instanceof List<Object>) {
                    List<Object> responseMessages = (List<Object>)result.get('messages');
                    if (!responseMessages.isEmpty()) {
                        // Assuming the first message in the list is the primary response
                        Map<String, Object> firstMessageWrapper = (Map<String, Object>)responseMessages.get(0);
                        if(firstMessageWrapper.containsKey('message') && firstMessageWrapper.get('message') instanceof Map<String, Object>) {
                             Map<String, Object> actualMessage = (Map<String, Object>) firstMessageWrapper.get('message');
                             // Look for 'text' or potentially other response types if needed
                             if (actualMessage.containsKey('text')) {
                                 String agentResponseText = (String)actualMessage.get('text');
                                 System.debug('Agent response received successfully.');
                                 return agentResponseText;
                             }
                        }
                    }
                     System.debug('Agent response received, but no suitable message text found in the response structure.');
                    return ''; // Return empty if structure is unexpected or no text message found
                } else {
                     System.debug('Agent response received, but "messages" key is missing or not a list.');
                    return ''; // Return empty if structure is unexpected
                }
            } else {
                 // Handle API errors specifically for message sending
                 // Check for common session errors (e.g., 404 Not Found might mean session expired or invalid)
                 if (res.getStatusCode() == 404) {
                     System.debug('Send Message API returned 404. Session likely invalid or expired.');
                     throw new AuraHandledException('Agent session is invalid or has expired. Please start a new chat. (Status: 404)');
                 }
                String errorDetails = 'Status: ' + res.getStatusCode() + ', StatusText: ' + res.getStatus() + ', Body: ' + res.getBody();
                System.debug('Send Message API call failed: ' + errorDetails);
                 String parsedErrorMessage = parseErrorMessageFromBody(res.getBody(), 'Failed to get agent response');
                throw new AuraHandledException(parsedErrorMessage + ' (Status: ' + res.getStatusCode() + ')');
            }
        } catch (Exception e) {
             if (e instanceof AuraHandledException) {
                 throw e;
             }
            String errorMsg = 'Exception during getAgentRecommendation: Type=' + e.getTypeName() + ', Msg=' + e.getMessage() + ', Line=' + e.getLineNumber();
            System.debug(errorMsg);
            System.debug('Stack trace: ' + e.getStackTraceString());
             String userFriendlyError = 'Error getting agent response: ' + e.getMessage();
             if (e instanceof System.CalloutException && e.getMessage().contains('Unauthorized endpoint')) {
                 userFriendlyError = 'Could not connect to the Einstein API. Please ensure the Remote Site Setting "Einstein_API" is active or a corresponding Named Credential exists.';
             } else if (e instanceof System.CalloutException && e.getMessage().contains('Read timed out')) {
                 userFriendlyError = 'The request to the agent timed out. Please try sending your message again.';
             }
            throw new AuraHandledException(userFriendlyError);
        }
    }

    /**
     * @description Ends the specified agent session.
     * @param sessionId The ID of the session to end.
     * @param consumerKey The Consumer Key for authentication.
     * @param consumerSecret The Consumer Secret for authentication.
     * @return String Confirmation message ('Session ended' or error details).
     */
    @AuraEnabled(cacheable=false)
    public static String endAgentSession(String sessionId, String consumerKey, String consumerSecret) {
         System.debug('Starting endAgentSession for sessionId: ' + sessionId);
        // Input validation
        if (String.isBlank(sessionId)) {
            System.debug('Validation Error: Session ID is blank.');
            throw new AuraHandledException('Session ID cannot be blank to end session.');
        }
         if (String.isBlank(consumerKey) || String.isBlank(consumerSecret)) {
            System.debug('Validation Error: Consumer Key or Secret is blank.');
            throw new AuraHandledException('Consumer Key and Consumer Secret are required for authentication.');
        }

        // Sanitize inputs
        consumerKey = consumerKey.trim();
        consumerSecret = consumerSecret.trim();
        sessionId = sessionId.trim();

        try {
            // 1. Obtain OAuth access token
            String accessToken = getAccessToken(consumerKey, consumerSecret);
             if (String.isBlank(accessToken)) {
                throw new AuraHandledException('Failed to obtain access token. Check previous logs.');
            }
             System.debug('Access token obtained successfully.');

            // 2. Prepare the API request to delete the session
            String endpoint = API_ENDPOINT + '/sessions/' + sessionId;
            System.debug('Calling End Session endpoint: ' + endpoint);

            HttpRequest req = new HttpRequest();
            req.setEndpoint(endpoint);
            req.setMethod('DELETE'); // Use DELETE method to end session
            req.setHeader('Authorization', 'Bearer ' + accessToken);
            // Optional: Provide a reason for ending the session
            req.setHeader('x-session-end-reason', 'UserRequest');
            // Content-Type might not be strictly required for DELETE with no body, but can be included
            req.setHeader('Content-Type', 'application/json');
            req.setTimeout(CALLOUT_TIMEOUT_MS_API);

            // Note: Some APIs expect an empty JSON body '{}' even for DELETE,
            // but the Einstein Agent API spec doesn't explicitly require it for session end.
            // If issues arise, uncomment the next line:
            // req.setBody('{}');

            // 3. Send the request
            HttpResponse res = new Http().send(req);
            System.debug('End Session Response Status: ' + res.getStatusCode() + ' ' + res.getStatus());
            System.debug('End Session Response Body: ' + res.getBody()); // Body is often empty on success (204)

            // 4. Process the response
            // Successful session termination typically returns 204 No Content
            if (res.getStatusCode() == 204) {
                System.debug('Session ended successfully via API for sessionId: ' + sessionId);
                // Clear sequence ID for this session from our map
                clearSequence(sessionId);
                return 'Session ended';
            } else if (res.getStatusCode() == 404) {
                 // Session might already be ended or invalid
                 System.debug('End Session returned 404. Session likely already ended or invalid for sessionId: ' + sessionId);
                 clearSequence(sessionId); // Clear sequence anyway
                 return 'Session already ended or invalid';
            }
            else {
                // Handle other errors
                String errorDetails = 'Status: ' + res.getStatusCode() + ', StatusText: ' + res.getStatus() + ', Body: ' + res.getBody();
                System.debug('End Session API call failed: ' + errorDetails);
                 String parsedErrorMessage = parseErrorMessageFromBody(res.getBody(), 'Failed to end session');
                 // Return error details, don't throw exception here as LWC might want to handle gracefully
                return parsedErrorMessage + ' (Status: ' + res.getStatusCode() + ')';
            }
        } catch (Exception e) {
             if (e instanceof AuraHandledException) {
                 // Let specific auth/validation errors bubble up
                 throw e;
             }
            String errorMsg = 'Exception during endAgentSession: Type=' + e.getTypeName() + ', Msg=' + e.getMessage() + ', Line=' + e.getLineNumber();
            System.debug(errorMsg);
            System.debug('Stack trace: ' + e.getStackTraceString());
             String userFriendlyError = 'Error ending agent session: ' + e.getMessage();
             if (e instanceof System.CalloutException && e.getMessage().contains('Unauthorized endpoint')) {
                 userFriendlyError = 'Could not connect to the Einstein API. Please ensure the Remote Site Setting "Einstein_API" is active or a corresponding Named Credential exists.';
             }
            // Throw exception so LWC knows the operation failed critically
            throw new AuraHandledException(userFriendlyError);
        }
    }

    /**
     * @description Retrieves an OAuth 2.0 access token using the Client Credentials flow.
     * Uses a simple time-based cache to avoid redundant calls.
     * NOTE: Assumes a Connected App is set up for Client Credentials flow.
     * Consider using Named Credentials with OAuth for a more Salesforce-idiomatic approach.
     * @param consumerKey The Connected App's Consumer Key.
     * @param consumerSecret The Connected App's Consumer Secret.
     * @return String The access token, or null/throws exception on failure.
     */
    private static String getAccessToken(String consumerKey, String consumerSecret) {
        // Check cache first (allow 60s buffer before expiry)
        Long currentTime = System.currentTimeMillis() / 1000; // Current time in seconds
        if (String.isNotBlank(cachedAccessToken) && tokenExpiration > (currentTime + 60)) {
            System.debug('Using cached access token.');
            return cachedAccessToken;
        } else {
            System.debug('Cached token missing or expired. Requesting new access token.');
            cachedAccessToken = null; // Clear potentially expired token
            tokenExpiration = 0;
        }

        // Input validation (should have been done by caller, but double-check)
         if (String.isBlank(consumerKey) || String.isBlank(consumerSecret)) {
            System.debug('getAccessToken Error: Consumer Key or Secret is blank.');
            // Throwing here prevents proceeding with a bad request
            throw new AuraHandledException('Consumer Key and Consumer Secret are required for authentication.');
        }

        try {
            // Prepare the OAuth token request
            HttpRequest req = new HttpRequest();
            req.setEndpoint(AUTH_ENDPOINT);
            req.setMethod('POST');
            req.setHeader('Content-Type', 'application/x-www-form-urlencoded');
            req.setTimeout(CALLOUT_TIMEOUT_MS_AUTH); // Use auth timeout

            // Construct the body for client_credentials flow
            // IMPORTANT: Do NOT URL encode the entire body string. Encode individual parameters if they contain special chars,
            // but client_id and client_secret from Salesforce Connected Apps typically don't require this.
            // Using simple concatenation as special chars are unlikely here.
             String requestBody = 'grant_type=client_credentials' +
                                 '&client_id=' + consumerKey +
                                 '&client_secret=' + consumerSecret;

            req.setBody(requestBody);
            // Avoid logging the full body with the secret in production environments
            System.debug('Auth Request Endpoint: ' + AUTH_ENDPOINT);
            System.debug('Auth Request Body (Secret Redacted): grant_type=client_credentials&client_id=' + consumerKey + '&client_secret=[REDACTED]');

            // Send the request
            HttpResponse res = new Http().send(req);
            System.debug('Auth Response Status: ' + res.getStatusCode() + ' ' + res.getStatus());
            // Only log body on non-200 status for security
             if(res.getStatusCode() != 200) {
                 System.debug('Auth Response Body (Error): ' + res.getBody());
             }


            // Process the response
            if (res.getStatusCode() == 200) {
                Map<String, Object> tokenResponse = (Map<String, Object>)JSON.deserializeUntyped(res.getBody());
                String newAccessToken = (String)tokenResponse.get('access_token');

                if (String.isBlank(newAccessToken)) {
                    System.debug('Error: access_token not found in successful auth response.');
                    throw new AuraHandledException('Authentication succeeded but no access_token was returned.');
                }

                // Cache the new token and calculate expiration time
                cachedAccessToken = newAccessToken;
                // Salesforce OAuth doesn't typically return 'expires_in', token lifetime is tied to session settings/policies.
                // We'll use a default reasonable cache duration (e.g., 30 minutes) if 'expires_in' isn't present.
                // Adjust this based on expected token validity or session timeout settings.
                Integer expiresIn = 1800; // Default: 30 minutes in seconds
                 if (tokenResponse.containsKey('expires_in') && tokenResponse.get('expires_in') instanceOf Integer) {
                     expiresIn = (Integer)tokenResponse.get('expires_in');
                 } else if (tokenResponse.containsKey('expires_in') && tokenResponse.get('expires_in') instanceOf String) {
                     try {
                         expiresIn = Integer.valueOf((String)tokenResponse.get('expires_in'));
                     } catch(Exception e) {
                         System.debug('Could not parse expires_in string: ' + tokenResponse.get('expires_in'));
                         expiresIn = 1800; // Fallback to default
                     }
                 }

                tokenExpiration = currentTime + expiresIn;
                System.debug('New access token obtained. Expires in approx ' + expiresIn + ' seconds. Cached until: ' + System.now().addSeconds(expiresIn));

                return cachedAccessToken;

            } else {
                // Handle authentication errors
                String errorBody = res.getBody();
                String errorDescription = 'Authentication failed.';
                 // Try to parse standard OAuth error response
                 try {
                     Map<String, Object> errorResponse = (Map<String, Object>)JSON.deserializeUntyped(errorBody);
                     if(errorResponse.containsKey('error_description')) {
                         errorDescription = (String)errorResponse.get('error_description');
                     } else if (errorResponse.containsKey('error')) {
                          errorDescription = (String)errorResponse.get('error');
                     } else {
                         errorDescription = errorBody; // Fallback to full body if no standard fields found
                     }
                 } catch (Exception jsonEx) {
                     System.debug('Could not parse auth error body as JSON: ' + jsonEx.getMessage());
                     errorDescription = errorBody; // Use raw body if parsing fails
                 }
                System.debug('Authentication API call failed: Status=' + res.getStatusCode() + ', Description=' + errorDescription);
                throw new AuraHandledException('Authentication failed: ' + errorDescription + ' (Status: ' + res.getStatusCode() + ')');
            }
        } catch (Exception e) {
             if (e instanceof AuraHandledException) {
                 throw e;
             }
            String errorMsg = 'Exception during getAccessToken: Type=' + e.getTypeName() + ', Msg=' + e.getMessage() + ', Line=' + e.getLineNumber();
            System.debug(errorMsg);
            System.debug('Stack trace: ' + e.getStackTraceString());
             String userFriendlyError = 'Error during authentication: ' + e.getMessage();
             if (e instanceof System.CalloutException && e.getMessage().contains('Unauthorized endpoint')) {
                 userFriendlyError = 'Could not connect to the Authentication Server ('+AUTH_ENDPOINT+'). Please ensure this URL is accessible and check Remote Site Settings or Named Credentials if applicable.';
             } else if (e instanceof System.CalloutException && e.getMessage().contains('Read timed out')) {
                 userFriendlyError = 'The authentication request timed out. Please check connectivity and try again.';
             }
            throw new AuraHandledException(userFriendlyError);
        }
    }


    /**
     * @description Placeholder method for saving chat transcripts. Implement actual saving logic here.
     * @param messages JSON string representing the list of messages.
     * @return String Result message (currently null).
     */
    @AuraEnabled(cacheable=false)
    public static String saveChatTranscript(String messages) {
        // TODO: Implement logic to parse the messages JSON and save it
        // e.g., Create a custom object record, attach to a Case/Contact, etc.
        System.debug('saveChatTranscript called. Message data length: ' + (messages != null ? messages.length() : 0));
        System.debug('Save Transcript Logic NOT IMPLEMENTED.');
        // Example:
        // List<Map<String, Object>> messageList = (List<Map<String, Object>>) JSON.deserializeUntyped(messages);
        // Create records based on messageList...
        return null; // Or return an ID or status message
    }

    /**
     * @description Placeholder method for adding a single message to an ongoing conversation record.
     * @param sessionId Might be used to find the parent conversation record.
     * @param message The message text.
     * @param isFromUser Boolean indicating the sender.
     * @return String Result message (currently null).
     */
    @AuraEnabled(cacheable=false)
    public static String addMessageToConversation(String sessionId, String message, Boolean isFromUser) {
        // TODO: Implement logic to find the conversation record (perhaps linked by sessionId or another key)
        // and add this message as a related record.
         System.debug('addMessageToConversation called for session: ' + sessionId + ', Is User: ' + isFromUser);
         System.debug('Add Message Logic NOT IMPLEMENTED.');
        return null;
    }


    /**
     * @description Increments and returns the sequence ID for a given session.
     * Used to ensure messages are processed in order by the agent.
     * @param sessionId The session identifier.
     * @return Integer The next sequence ID for the session.
     */
    private static Integer incrementSequence(String sessionId) {
        Integer seq = seqIds.containsKey(sessionId) ? seqIds.get(sessionId) + 1 : 1;
        seqIds.put(sessionId, seq);
         System.debug('Incremented sequence for session ' + sessionId + ' to: ' + seq);
        return seq;
    }

     /**
     * @description Clears the sequence ID tracking for a finished session.
     * @param sessionId The session identifier to clear.
     */
    private static void clearSequence(String sessionId) {
        if (seqIds.containsKey(sessionId)) {
            seqIds.remove(sessionId);
            System.debug('Cleared sequence tracking for ended session: ' + sessionId);
        }
    }

    /**
     * @description Generates a random UUID string.
     * @return String A random UUID.
     */
    private static String generateUUID() {
        // Uses Apex's built-in UUID generation which relies on Blob/Crypto
        return EncodingUtil.convertToHex(Crypto.generateAesKey(128)).substring(0,36);
        // The original UUID.randomUUID() doesn't exist in Apex. This provides a similar random string.
        // A more standard UUID v4 format if needed:
        // Blob b = Crypto.generateAesKey(128);
        // String h = EncodingUtil.convertToHex(b);
        // return h.substring(0,8)+'-'+h.substring(8,12)+'-4'+h.substring(13,16)+'-a'+h.substring(17,20)+'-'+h.substring(20,32);
    }

    /**
     * @description Helper to parse common error structures from API response bodies.
     * @param responseBody The raw response body string.
     * @param defaultMessage A default message if parsing fails or no specific error is found.
     * @return String The parsed error message or the default.
     */
    private static String parseErrorMessageFromBody(String responseBody, String defaultMessage) {
        if (String.isBlank(responseBody)) {
            return defaultMessage;
        }
        try {
            Map<String, Object> errorData = (Map<String, Object>)JSON.deserializeUntyped(responseBody);
            // Common Salesforce API error structures
            if (errorData.containsKey('message')) {
                return (String)errorData.get('message');
            }
            if (errorData.containsKey('error_description')) {
                 return (String)errorData.get('error_description');
            }
             if (errorData.containsKey('error') && errorData.get('error') instanceof String) {
                 return (String)errorData.get('error');
            }
            // Einstein Agent API specific error structure (sometimes nested)
             if (errorData.containsKey('detail') && errorData.get('detail') instanceof String) {
                  return (String)errorData.get('detail');
             }
             // Check for array structure like [{"message": "...", "errorCode": "..."}]
             if(errorData.isEmpty() && responseBody.trim().startsWith('[')) {
                 List<Object> errors = (List<Object>)JSON.deserializeUntyped(responseBody);
                 if (!errors.isEmpty() && errors[0] instanceof Map<String, Object>) {
                     Map<String, Object> firstError = (Map<String, Object>) errors[0];
                      if (firstError.containsKey('message')) {
                          return (String)firstError.get('message');
                      }
                 }
             }

            // If no common patterns match, return default or raw body if short
             return (responseBody.length() < 200) ? responseBody : defaultMessage;

        } catch (Exception e) {
            System.debug('Failed to parse error response body: ' + e.getMessage());
             // Return default or raw body if short
             return (responseBody.length() < 200) ? responseBody : defaultMessage;
        }
    }
}
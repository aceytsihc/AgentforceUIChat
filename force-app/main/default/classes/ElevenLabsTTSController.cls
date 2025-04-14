public without sharing class ElevenLabsTTSController {

    private static final String ELEVENLABS_API_ENDPOINT = 'https://api.elevenlabs.io/v1/text-to-speech/';
    private static final Integer CALLOUT_TIMEOUT_MS = 60000; // 60 seconds timeout

    /**
     * @description Calls the ElevenLabs API to generate speech from text.
     * @param text The text to synthesize.
     * @param elevenLabsApiKey Your ElevenLabs API Key.
     * @param voiceId The ElevenLabs Voice ID to use (e.g., '21m00Tcm4TlvDq8ikWAM' for Rachel).
     * @return String A Base64 encoded Data URI string ('data:audio/mpeg;base64,...') or null on failure.
     */
    @AuraEnabled(cacheable=false)
    public static String generateSpeech(String text, String elevenLabsApiKey, String voiceId) {
        if (String.isBlank(text)) {
            System.debug('ElevenLabsTTSController.generateSpeech: Text cannot be blank.');
            throw new AuraHandledException('Text cannot be blank.');
        }
        if (String.isBlank(elevenLabsApiKey)) {
            System.debug('ElevenLabsTTSController.generateSpeech: ElevenLabs API Key is required.');
            throw new AuraHandledException('ElevenLabs API Key is required. Please configure it in the component settings.');
        }
        if (String.isBlank(voiceId)) {
            System.debug('ElevenLabsTTSController.generateSpeech: ElevenLabs Voice ID is required.');
            throw new AuraHandledException('ElevenLabs Voice ID is required.');
        }

        String endpoint = ELEVENLABS_API_ENDPOINT + voiceId;
        System.debug('ElevenLabsTTSController: Calling endpoint: ' + endpoint);

        HttpRequest req = new HttpRequest();
        req.setEndpoint(endpoint);
        req.setMethod('POST');
        req.setHeader('Content-Type', 'application/json');
        req.setHeader('Accept', 'audio/mpeg'); // Crucial: Ask for audio data
        req.setHeader('xi-api-key', elevenLabsApiKey); // API Key header
        req.setTimeout(CALLOUT_TIMEOUT_MS);

        // Construct the JSON payload for ElevenLabs API
        Map<String, Object> payload = new Map<String, Object>{
            'text' => text,
            'model_id' => 'eleven_multilingual_v2', // Or another suitable model
            'voice_settings' => new Map<String, Object>{
                'stability' => 0.5,
                'similarity_boost' => 0.75
                //'style' => 0.0, // Optional: for style-specific voices
                //'use_speaker_boost' => true // Optional
            }
        };
        String requestBody = JSON.serialize(payload);
        req.setBody(requestBody);
        System.debug('ElevenLabsTTSController: Request Body (Text Redacted): ' + requestBody.replace(text, '[TEXT REDACTED]'));


        Http http = new Http();
        HttpResponse res = null;
        try {
            res = http.send(req);
            System.debug('ElevenLabsTTSController: Response Status Code: ' + res.getStatusCode());

            if (res.getStatusCode() == 200) {
                // Success! Get the audio data as a Blob
                Blob audioBlob = res.getBodyAsBlob();
                if (audioBlob != null && audioBlob.size() > 0) {
                    // Encode the Blob to Base64 and create a Data URI
                    String base64Audio = EncodingUtil.base64Encode(audioBlob);
                    String dataUri = 'data:audio/mpeg;base64,' + base64Audio;
                    System.debug('ElevenLabsTTSController: Successfully generated audio Data URI (length): ' + dataUri.length());
                    return dataUri;
                } else {
                    System.debug('ElevenLabsTTSController: Received 200 OK but audio blob is empty.');
                    throw new AuraHandledException('ElevenLabs API returned empty audio data.');
                }
            } else {
                // Handle API errors
                String errorBody = res.getBody();
                System.debug('ElevenLabsTTSController: API Error - Status: ' + res.getStatus() + ', Code: ' + res.getStatusCode() + ', Body: ' + errorBody);
                // Try parsing the error detail if JSON
                String detailedError = errorBody;
                try {
                    Map<String, Object> errorResponse = (Map<String, Object>)JSON.deserializeUntyped(errorBody);
                    if (errorResponse.containsKey('detail')) {
                        Object detail = errorResponse.get('detail');
                        if (detail instanceof Map<String, Object>) {
                             Map<String, Object> detailMap = (Map<String, Object>) detail;
                             if(detailMap.containsKey('message')) {
                                detailedError = (String) detailMap.get('message');
                             }
                        } else if (detail instanceof String) {
                            detailedError = (String) detail;
                        }
                    }
                } catch (Exception jsonEx) {
                    System.debug('ElevenLabsTTSController: Could not parse error body as JSON: ' + jsonEx.getMessage());
                }
                throw new AuraHandledException('ElevenLabs API request failed (' + res.getStatusCode() + '): ' + detailedError);
            }
        } catch (Exception e) {
            System.debug('ElevenLabsTTSController: Exception during callout: Type=' + e.getTypeName() + ', Msg=' + e.getMessage() + ', Stack=' + e.getStackTraceString());
            // Check for specific callout exceptions
             if (e instanceof System.CalloutException) {
                 if(e.getMessage().contains('Read timed out')) {
                      throw new AuraHandledException('The request to ElevenLabs timed out. Please try again.');
                 } else if (e.getMessage().contains('Unauthorized endpoint')) {
                     throw new AuraHandledException('Access to the ElevenLabs API endpoint is not authorized. Please check Remote Site Settings or Named Credentials.');
                 }
             }
            throw new AuraHandledException('Error calling ElevenLabs API: ' + e.getMessage());
        }
    }
}
// --- START OF FILE messengerChat.js ---
import { LightningElement, track, api } from 'lwc';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';
import { loadScript } from 'lightning/platformResourceLoader'; // If needed for external libs

// Apex Methods
import initializeAgentSession from '@salesforce/apex/AgentChatController.initializeAgentSession';
import getAgentRecommendation from '@salesforce/apex/AgentChatController.getAgentRecommendation';
import endAgentSession from '@salesforce/apex/AgentChatController.endAgentSession';
import saveChatTranscript from '@salesforce/apex/AgentChatController.saveChatTranscript'; // Placeholder
import addMessageToConversation from '@salesforce/apex/AgentChatController.addMessageToConversation'; // Placeholder
import callElevenLabsTTS from '@salesforce/apex/ElevenLabsTTSController.generateSpeech'; // Import NEW TTS method

// Constants
const USER_SENDER = 'user';
const AGENT_SENDER = 'agent';
const SYSTEM_SENDER = 'system';
const DEBOUNCE_DELAY = 300; // ms delay for debouncing actions like resize
const TEXTAREA_MAX_HEIGHT = 100; // px
const TYPING_INDICATOR_TEXT = 'Agent is thinking...'; // New typing text
const CONNECTING_TEXT = 'Connecting to Agentforce...';
const RECONNECTING_TEXT = 'Reconnecting...';
const CONNECTION_ERROR_TEXT = "Sorry, I couldn't connect right now. Please try again later.";
const DEFAULT_VOICE_ID = '21m00Tcm4TlvDq8ikWAM'; // Default ElevenLabs Voice ID (Rachel)

export default class AgentChat extends LightningElement {
    // --- Component Properties (from metadata) ---
    @api agentName = 'Agentforce';
    @api agentId = ''; // Required
    @api connectedAppConsumerKey = ''; // Required
    @api connectedAppConsumerSecret = ''; // Required
    @api defaultDarkMode = false;
    @api welcomeMessage = 'Hello! I am your AI Agent. How can I help you today?';
    @api allowVoiceMode = false;
    @api position = 'bottom-right';
    @api headerText = 'Agentforce Support';
    @api elevenLabsApiKey = '';  // Required
    @api elevenLabsVoiceId = DEFAULT_VOICE_ID;

    // --- Reactive State Variables ---
    @track messages = [];
    @track currentMessageText = '';
    @track isDarkMode = false;
    @track showChatBubble = true;
    @track showChatWindow = false;
    @track chatHasEnded = false;
    @track showEndChatModal = false;
    @track showOptionsMenu = false;
    @track isExpanded = false;
    @track isAgentTyping = false; // Tracks if agent is currently "thinking" or generating response
    @track componentState = 'minimized'; // 'minimized', 'active', 'ended', 'initializing'
    @track chatWindowStyle = ''; // For draggable positioning

    // --- Voice Mode State ---
    @track isVoiceModeAvailable = false; // Determined by browser support
    @track isVoiceModeActive = false;
    @track isListeningForInput = false; // User mic is active
    @track isAgentSpeaking = false; // TTS is playing
    @track voiceStatusText = '';

    // --- Internal Component State ---
    sessionId = null;
    isInitialized = false; // Has the *first* successful initialization occurred?
    isInitializing = false; // Actively trying to initialize *now*?
    isSessionEnding = false;
    initialWelcomeMessageSent = false; // Ensure welcome message logic runs only once per open
    lastMessageId = 0; // Simple message ID generation
    textareaRef = null;
    messageContainerRef = null;
    currentAudio = null; // Reference to the playing <audio> element
    recognition = null; // SpeechRecognition instance
    isDragging = false;
    dragStartX = 0;
    dragStartY = 0;
    windowStartX = 0;
    windowStartY = 0;
    resizeTimeout;
    outsideClickListener;

    // --- Lifecycle Hooks ---
    connectedCallback() {
        this.loadThemePreference();
        this.componentState = 'minimized';
        this.checkVoiceSupport();
        this.addWindowListeners();
        // Set initial position (important for drag calculation)
         this.updateWindowPositionStyle(this.position);
    }

    renderedCallback() {
        // Refs available after render
        this.textareaRef = this.refs.textarea;
        this.messageContainerRef = this.refs.messageContainer;

        // Only run after chat window is shown
        if (this.showChatWindow) {
            this.scrollToBottom(); // Ensure scroll on new messages/render
            this.renderAgentMessagesWithHTML(); // Handle manual HTML rendering
        }
        // Apply loaded class after initial render for animation
        if(this.showChatWindow && !this.template.querySelector('.chat-window.loaded')){
             const windowEl = this.template.querySelector('.chat-window');
             if(windowEl) {
                 windowEl.classList.add('loaded');
             }
        }
    }

    disconnectedCallback() {
        this.removeWindowListeners();
        this.endChatSessionInternal(false); // Attempt to clean up session if component removed
        this.stopAudioPlayback(); // Stop any lingering audio
        this.stopVoiceRecognition(); // Stop recognition
        if (this.outsideClickListener) {
            document.removeEventListener('click', this.outsideClickListener);
        }
    }

    // --- Initialization and Session Management ---

    async initializeChatSession() {
        if (this.isInitializing || this.isInitialized) {
            console.log('Initialization skipped (already initializing or initialized).');
            return;
        }
        if (!this.agentId || !this.connectedAppConsumerKey || !this.connectedAppConsumerSecret) {
            this.showConfigError('Configuration incomplete. Please provide Agent ID, Consumer Key, and Consumer Secret.');
            return;
        }

        console.log('Initializing Agentforce session...');
        this.isInitializing = true;
        this.isInitialized = false; // Reset initialization status
        this.componentState = 'initializing';
        this.sessionId = null; // Ensure no stale session ID is used
        this.clearMessages(); // Start with a clean slate
        this.addSystemMessage(CONNECTING_TEXT, 'init_connect');

        try {
            const result = await initializeAgentSession({
                agentId: this.agentId,
                consumerKey: this.connectedAppConsumerKey,
                consumerSecret: this.connectedAppConsumerSecret
            });

            if (result) {
                console.log('Session initialized successfully. Session ID:', result);
                this.sessionId = result;
                this.isInitialized = true;
                this.removeSystemMessageById('init_connect'); // Remove connecting message
                this.componentState = 'active';

                // Send initial welcome/greeting *only if* the welcome message API isn't blank
                if (!this.initialWelcomeMessageSent && this.welcomeMessage) {
                     // Add the configured welcome message directly
                     this.addAgentMessage(this.welcomeMessage, true); // true = isRawHtml (assume welcome might be basic HTML)
                     this.initialWelcomeMessageSent = true;
                } else if (!this.initialWelcomeMessageSent) {
                    // If no welcome message configured, maybe send a generic "Hello" to trigger agent's default greeting
                    console.log('No welcome message configured, sending "Hello" to agent.');
                    this.getUserAgentResponse('Hello'); // Let agent respond
                    this.initialWelcomeMessageSent = true;
                }

            } else {
                throw new Error('Session initialization returned no Session ID.');
            }
        } catch (error) {
            console.error('Error initializing Agentforce session:', error);
            this.removeSystemMessageById('init_connect');
            this.showInitializationError(this.getErrorMessage(error));
             this.componentState = 'error'; // Indicate an error state
        } finally {
            this.isInitializing = false;
        }
    }

    // Called when user clicks End Chat button confirms
    async confirmEndChat() {
        this.showEndChatModal = false;
        await this.endChatSessionInternal(true); // true = show message
    }

    // Internal session ending logic
    async endChatSessionInternal(showUserMessage) {
        if (this.isSessionEnding || !this.sessionId) {
            // Already ending or no session to end, just reset UI
            this.resetChatUI();
            return;
        }

        console.log('Ending chat session:', this.sessionId);
        this.isSessionEnding = true;
        this.stopAudioPlayback();
        this.stopVoiceRecognition();
        if (this.isVoiceModeActive) {
            this.toggleVoiceInput(); // Exit voice mode UI
        }

        if (showUserMessage) {
            this.addSystemMessage('Ending conversation...');
        }

        try {
            await endAgentSession({
                sessionId: this.sessionId,
                consumerKey: this.connectedAppConsumerKey,
                consumerSecret: this.connectedAppConsumerSecret
            });
            console.log('Agent session ended successfully via API.');
        } catch (error) {
            console.error('Error ending agent session via API:', error);
            // Show toast but don't block UI reset
            this.showToast('Error', 'Could not formally end the agent session: ' + this.getErrorMessage(error), 'error');
        } finally {
            this.sessionId = null;
            this.isInitialized = false;
            this.isSessionEnding = false;
            this.initialWelcomeMessageSent = false;
            if (showUserMessage) {
                this.chatHasEnded = true; // Show the "Chat Ended" screen
                this.showChatWindow = false; // Hide main window
                this.showChatBubble = false; // Hide bubble temporarily
                 this.componentState = 'ended';
            } else {
                 // If ending internally (e.g. disconnectedCallback), just reset state
                 this.resetChatUI();
            }
        }
    }

    // Resets UI to initial state (bubble visible)
    resetChatUI() {
        this.showChatWindow = false;
        this.showChatBubble = true;
        this.chatHasEnded = false;
        this.isExpanded = false;
        this.messages = [];
         this.componentState = 'minimized';
         // Reset drag position if needed
         this.updateWindowPositionStyle(this.position);
         const chatWindow = this.template.querySelector('.chat-window');
         if (chatWindow) {
             chatWindow.classList.remove('expanded', 'dragging', 'loaded');
             chatWindow.style.transform = ''; // Reset transform
         }
    }

    // Called from "Chat Ended" screen
    startNewChat() {
        this.resetChatUI();
        // Clicking bubble will trigger initialization again
    }


    // --- Message Handling ---

    handleMessageChange(event) {
        this.currentMessageText = event.target.value;
        this.autoExpandTextarea();
    }

    handleKeyPress(event) {
        // Send on Enter (if not Shift+Enter)
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault(); // Prevent newline
            this.sendMessage();
        }
        // Auto-expand on key press too for immediate feedback
         this.autoExpandTextarea();
    }

    sendMessage() {
        const textToSend = this.currentMessageText.trim();
        if (!textToSend || this.isInputDisabled) {
            return;
        }

        console.log('Sending message:', textToSend);
        this.addUserMessage(textToSend); // Add user message immediately
        this.getUserAgentResponse(textToSend); // Get agent response

        // Clear input and reset textarea height
        this.currentMessageText = '';
        if (this.textareaRef) {
            this.textareaRef.value = '';
            this.textareaRef.style.height = 'auto'; // Reset height
        }
    }

    // Gets response from Agent and handles typing indicator + errors
    async getUserAgentResponse(messageText) {
        if (this.isAgentTyping || !this.sessionId) {
             console.warn('Agent response skipped (already typing or no session)');
             return;
        }

        this.isAgentTyping = true;
        const typingMsgId = this.addSystemMessage(TYPING_INDICATOR_TEXT, null, true); // isTyping = true

        try {
            const response = await getAgentRecommendation({
                sessionId: this.sessionId,
                message: messageText,
                consumerKey: this.connectedAppConsumerKey,
                consumerSecret: this.connectedAppConsumerSecret
            });

            this.removeSystemMessageById(typingMsgId); // Remove typing indicator

            if (response) {
                console.log('Agent response received.');
                this.addAgentMessage(response, true); // Assume response might contain HTML

                // If in voice mode, speak the response (strip HTML for TTS)
                if (this.isVoiceModeActive) {
                    this.speakAgentResponse(response);
                }
            } else {
                 console.log('Agent returned an empty response.');
                 // Optionally add a message like "I don't have a response for that."
                 this.addAgentMessage("I'm sorry, I could not find an answer for that.", false);
                 if (this.isVoiceModeActive) {
                    this.speakAgentResponse("I'm sorry, I could not find an answer for that.");
                 }
            }

        } catch (error) {
            console.error('Error getting agent recommendation:', error);
            this.removeSystemMessageById(typingMsgId); // Remove typing indicator on error
            const errorMsg = this.getErrorMessage(error);
            // Check if it's a session expiry error (e.g., 404)
             if (error.body?.message?.includes('expired') || error.body?.message?.includes('invalid') || error.status === 404 || error.message?.includes('404')) {
                 console.warn('Session likely expired. Attempting to re-initialize.');
                 this.addSystemMessage('Session expired. Reconnecting...');
                 this.isInitialized = false; // Force re-init
                 this.sessionId = null;
                 await this.initializeChatSession(); // Try to re-establish
                 // If re-init successful, try sending the message again? (Optional)
                 if(this.isInitialized) {
                     console.log('Re-initialization successful, resending message.');
                     this.getUserAgentResponse(messageText);
                 } else {
                     this.addSystemMessage("Failed to reconnect. Please start a new chat.");
                 }
             } else {
                this.addSystemMessage(`Error: ${errorMsg}`, null, false, true); // isError = true
             }
        } finally {
            this.isAgentTyping = false;
        }
    }

    // --- Message Adding/Formatting Utilities ---

    addMessage(text, sender, id = null, isTyping = false, isError = false, isRawHtml = false) {
        if (!text && !isTyping) return; // Allow typing indicator with no text initially

        const messageId = id || `msg_${++this.lastMessageId}`;
        const timestamp = this.getTimestamp();
        let cssClass = `message ${sender}-message`;
        if (isTyping) cssClass += ' typing-message';
        if (isError) cssClass += ' error-message';

        const messageObj = {
            id: messageId,
            sender: sender,
            text: text,
            timestamp: timestamp,
            cssClass: cssClass,
            isUserMessage: sender === USER_SENDER,
            isAgentMessage: sender === AGENT_SENDER,
            isSystemMessage: sender === SYSTEM_SENDER,
            isTypingMessage: isTyping,
            isErrorMessage: isError,
            rawHtml: isRawHtml && sender === AGENT_SENDER && !isTyping, // Only allow raw HTML for non-typing agent messages
            thinkingProcess: null, // Initialize thinking process placeholder
            hasThinkingProcess: false
        };

        // Extract <think> tags for agent messages *before* adding to array
         if (messageObj.isAgentMessage && !messageObj.isTypingMessage && messageObj.text) {
             const thinkTagRegex = /<think>([\s\S]*?)<\/think>/i; // Case-insensitive
             const match = messageObj.text.match(thinkTagRegex);
             if (match && match[1]) {
                 messageObj.thinkingProcess = match[1].trim();
                 messageObj.hasThinkingProcess = true;
                 // Remove the <think> tag from the displayed text
                 messageObj.text = messageObj.text.replace(thinkTagRegex, '').trim();
                 console.log(`Extracted thinking process for message ${messageId}`);
             }
         }

        this.messages = [...this.messages, messageObj];
        this.scrollToBottom();
        return messageId; // Return the ID for potential removal (like typing indicators)
    }

    addUserMessage(text) {
        this.addMessage(text, USER_SENDER);
    }

    // Adds agent message, sets rawHtml flag if needed
    addAgentMessage(text, isRawHtml = false) {
        this.addMessage(text, AGENT_SENDER, null, false, false, isRawHtml);
    }

    // Adds system message (e.g., connecting, errors)
    addSystemMessage(text, id = null, isTyping = false, isError = false) {
        return this.addMessage(text, SYSTEM_SENDER, id, isTyping, isError);
    }

    removeSystemMessageById(id) {
        if (!id) return;
        this.messages = this.messages.filter(m => m.id !== id);
    }

    clearMessages() {
        this.messages = [];
        this.lastMessageId = 0;
    }

    getTimestamp() {
        return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
    }

    // Handles rendering of messages marked with rawHtml=true
    renderAgentMessagesWithHTML() {
        this.messages.forEach(message => {
            if (message.rawHtml && message.isAgentMessage) {
                const container = this.template.querySelector(`.lwc-manual-render[data-id="${message.id}"]`);
                if (container && !container.dataset.rendered) { // Render only once
                    try {
                        // Basic sanitization (remove script tags) - consider a more robust library if needed
                        let sanitizedHtml = message.text.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
                        container.innerHTML = sanitizedHtml;
                        container.dataset.rendered = 'true'; // Mark as rendered

                        // Post-render processing (e.g., make links clickable)
                         this.enhanceRenderedHTML(container);

                    } catch (e) {
                        console.error(`Error rendering HTML for message ${message.id}:`, e);
                        container.textContent = '[Error displaying content]';
                    }
                }
            }
        });
    }

     enhanceRenderedHTML(container) {
         // Make links open in new tabs
         const links = container.querySelectorAll('a');
         links.forEach(link => {
             link.target = '_blank';
             link.rel = 'noopener noreferrer';
         });
         // Add more enhancements if needed (e.g., style tables, code blocks)
     }

    // --- UI Event Handlers ---

    handleChatBubbleClick() {
        console.log('Chat bubble clicked');
        this.showChatBubble = false;
        this.showChatWindow = true;
         this.componentState = 'initializing'; // Show connecting state initially
         requestAnimationFrame(() => {
             this.textareaRef?.focus();
         });
        // Initialize session only when window opens
        this.initializeChatSession();
    }

    handleMinimizeToBubble() {
        console.log('Minimizing to bubble');
        this.showChatWindow = false;
        this.showChatBubble = true;
        this.showOptionsMenu = false;
        this.componentState = 'minimized';
        this.stopAudioPlayback(); // Stop audio when minimizing
        this.stopVoiceRecognition();
         if (this.isVoiceModeActive) {
             this.toggleVoiceInput(); // Ensure voice mode UI is turned off
         }
         // Don't end the session here, just hide the window
    }

    handleToggleExpand() {
        this.isExpanded = !this.isExpanded;
        this.showOptionsMenu = false;
         const chatWindow = this.template.querySelector('.chat-window');
         if(chatWindow) {
             chatWindow.classList.toggle('expanded', this.isExpanded);
             // Reset drag styles if contracting
             if (!this.isExpanded) {
                 this.updateWindowPositionStyle(this.position, this.windowStartX, this.windowStartY);
                 chatWindow.style.transform = '';
             } else {
                 // Clear inline styles when expanding
                 chatWindow.style.left = '';
                 chatWindow.style.top = '';
                 chatWindow.style.right = '';
                 chatWindow.style.bottom = '';
                  chatWindow.style.transform = '';
             }
         }
         // Re-calculate scroll after expand/contract transition
         setTimeout(() => this.scrollToBottom(), 350);
    }

    handleToggleTheme() {
        this.isDarkMode = !this.isDarkMode;
        this.updateTheme();
        this.saveThemePreference();
        this.showOptionsMenu = false;
    }

     handleCopyTranscript() {
         const transcriptText = this.messages.map(m => {
             const prefix = m.isUserMessage ? 'You' : (m.isAgentMessage ? this.agentName : 'System');
             // Basic text extraction, strip HTML for copying
             const textContent = this.stripHtml(m.text || '');
             return `${prefix} (${m.timestamp}): ${textContent}`;
         }).join('\n');

         if (navigator.clipboard) {
             navigator.clipboard.writeText(transcriptText).then(() => {
                 this.showToast('Success', 'Chat transcript copied to clipboard.', 'success');
             }).catch(err => {
                  this.showToast('Error', 'Could not copy transcript: ' + err, 'error');
             });
         } else {
              this.showToast('Warning', 'Clipboard API not available in this browser.', 'warning');
         }
         this.showOptionsMenu = false;
     }

    toggleOptionsMenu() {
        this.showOptionsMenu = !this.showOptionsMenu;
        if (this.showOptionsMenu) {
             // Add listener to close menu when clicking outside
             // Use a bound function reference for easy removal
             this.outsideClickListener = this.handleOutsideClick.bind(this);
             // Delay adding listener slightly to prevent immediate closure
             setTimeout(() => {
                 document.addEventListener('click', this.outsideClickListener);
             }, 0);
         } else {
             if (this.outsideClickListener) {
                 document.removeEventListener('click', this.outsideClickListener);
             }
         }
    }

     // Close menu if click is outside
     handleOutsideClick(event) {
         const menuElement = this.template.querySelector('.options-menu');
         const toggleButton = this.template.querySelector('.options-toggle');
         if (menuElement && !menuElement.contains(event.target) && toggleButton && !toggleButton.contains(event.target)) {
             this.showOptionsMenu = false;
             document.removeEventListener('click', this.outsideClickListener); // Clean up listener
         }
     }

     // Prevent menu closing when clicking inside it
     handleMenuClick(event) {
         event.stopPropagation();
     }

    showEndChatConfirmation() {
        this.stopAudioPlayback(); // Stop audio before showing modal
        this.showEndChatModal = true;
        this.showOptionsMenu = false; // Close options menu
    }

    cancelEndChat() {
        this.showEndChatModal = false;
    }

    // --- Voice Mode Handling ---

    checkVoiceSupport() {
        this.isVoiceModeAvailable = ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window) &&
                                   ('speechSynthesis' in window);
         if (!this.isVoiceModeAvailable) {
             console.warn('Voice Recognition or Speech Synthesis not supported by this browser.');
         }
    }

    handleToggleVoiceMode() {
         if (!this.isVoiceModeAvailable) {
             this.showToast('Not Supported', 'Voice mode is not available in your browser.', 'warning');
             return;
         }
        this.toggleVoiceInput();
        this.showOptionsMenu = false;
    }

    toggleVoiceInput() {
         if (this.isVoiceModeActive) {
             // --- Turning Voice Mode OFF ---
             console.log('Turning Voice Mode OFF');
             this.isVoiceModeActive = false;
             this.isListeningForInput = false;
             this.isAgentSpeaking = false;
             this.voiceStatusText = '';
             this.stopAudioPlayback();
             this.stopVoiceRecognition();
             // Ensure textarea is enabled
             if (this.textareaRef) this.textareaRef.disabled = false;
         } else {
             // --- Turning Voice Mode ON ---
             console.log('Turning Voice Mode ON');
             this.isVoiceModeActive = true;
             this.isAgentSpeaking = false; // Ensure speaking state is reset
             // Disable text input
             if (this.textareaRef) this.textareaRef.disabled = true;
             this.startVoiceRecognition(); // Start listening immediately
         }
    }

    startVoiceRecognition() {
        if (!this.isVoiceModeAvailable || !this.isVoiceModeActive || this.isListeningForInput) return;

        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!this.recognition) {
            this.recognition = new SpeechRecognition();
            this.recognition.continuous = false; // Stop after pause in speech
            this.recognition.interimResults = false; // Only process final results
            this.recognition.lang = 'en-US'; // Or make configurable

            this.recognition.onstart = () => {
                console.log('Voice recognition started.');
                this.isListeningForInput = true;
                this.voiceStatusText = 'Listening...';
            };

            this.recognition.onresult = (event) => {
                 const transcript = event.results[event.results.length - 1][0].transcript.trim();
                 console.log('Voice result (final):', transcript);
                 if (transcript) {
                     this.isListeningForInput = false; // Stop listening UI while processing
                     this.voiceStatusText = 'Processing...';
                     this.addUserMessage(transcript);
                     this.getUserAgentResponse(transcript); // Send transcript to agent
                 } else {
                      // If empty result, maybe restart listening?
                       this.voiceStatusText = 'Did not hear anything.';
                       setTimeout(() => this.startVoiceRecognition(), 500); // Restart after brief pause
                 }
            };

            this.recognition.onerror = (event) => {
                console.error('Speech recognition error:', event.error, event.message);
                this.isListeningForInput = false;
                 let errorMsg = 'Voice recognition error';
                 if (event.error === 'no-speech') {
                     errorMsg = 'No speech detected. Try again.';
                     // Optionally restart listening automatically
                     setTimeout(() => this.startVoiceRecognition(), 500);
                 } else if (event.error === 'audio-capture') {
                      errorMsg = 'Microphone error. Check permissions.';
                      this.toggleVoiceInput(); // Exit voice mode on critical error
                 } else if (event.error === 'not-allowed') {
                      errorMsg = 'Microphone access denied.';
                       this.toggleVoiceInput(); // Exit voice mode
                 } else {
                      errorMsg = `Error: ${event.error}`;
                 }
                 this.voiceStatusText = errorMsg;
                 // Don't automatically restart on all errors
            };

            this.recognition.onend = () => {
                console.log('Voice recognition ended.');
                this.isListeningForInput = false;
                // Only restart if we are still in voice mode and *not* waiting for agent speech
                if (this.isVoiceModeActive && !this.isAgentSpeaking && !this.isAgentTyping) {
                     console.log('Recognition ended, restarting listening...');
                     // Brief delay before restarting
                     setTimeout(() => this.startVoiceRecognition(), 100);
                 } else {
                      console.log('Recognition ended, not restarting.');
                 }
            };
        }

        // Start recognition if not already active
         try {
              this.recognition.start();
         } catch (e) {
              // Handle cases where it might already be started
              console.warn('Recognition start attempted but may have already been active:', e.message);
               // Ensure state is correct if start fails
               if(!this.isListeningForInput) {
                  this.isListeningForInput = true; // Assume it's running now
                  this.voiceStatusText = 'Listening...';
               }
         }
    }

    stopVoiceRecognition() {
        if (this.recognition) {
            try {
                this.recognition.stop();
                console.log('Voice recognition stopped.');
            } catch (e) {
                console.warn('Error stopping voice recognition:', e);
            }
             this.isListeningForInput = false;
             // this.recognition = null; // Consider nullifying to ensure fresh instance next time
        }
    }

    // Triggers TTS for the agent's response
    async speakAgentResponse(responseText) {
        if (!this.isVoiceModeActive || !this.elevenLabsApiKey) return;

        this.isAgentSpeaking = true;
        this.voiceStatusText = 'Agent is speaking...';
        this.stopVoiceRecognition(); // Stop listening while agent speaks

        // Strip HTML and <think> tags for TTS
        const cleanText = this.stripHtml(responseText).replace(/<think>[\s\S]*?<\/think>/i, '').trim();

        if (!cleanText) {
             console.log('No text content to speak after cleaning.');
             this.onSpeechEnd(); // Treat as speech ended
             return;
        }

        console.log('Requesting speech from ElevenLabs for:', cleanText.substring(0, 50) + '...');

        try {
            // Stop any currently playing audio *before* fetching new audio
            this.stopAudioPlayback();

            const dataUri = await callElevenLabsTTS({
                text: cleanText,
                elevenLabsApiKey: this.elevenLabsApiKey,
                voiceId: this.elevenLabsVoiceId || DEFAULT_VOICE_ID
            });

            if (dataUri) {
                console.log('Received audio Data URI from ElevenLabs.');
                this.currentAudio = new Audio(dataUri);

                this.currentAudio.addEventListener('ended', this.onSpeechEnd.bind(this));
                this.currentAudio.addEventListener('error', this.onSpeechError.bind(this));

                this.currentAudio.play().catch(e => {
                    console.error('Error playing ElevenLabs audio:', e);
                    this.onSpeechError(); // Handle playback error
                });
            } else {
                 throw new Error('ElevenLabs returned empty audio data.');
            }
        } catch (error) {
            console.error('Error generating/playing ElevenLabs speech:', error);
            this.showToast('TTS Error', 'Could not play agent response: ' + this.getErrorMessage(error), 'error');
            this.onSpeechError(); // Handle TTS generation error
        }
    }

    onSpeechEnd() {
        console.log('Speech playback ended.');
        this.currentAudio = null; // Clear reference
        this.isAgentSpeaking = false;
        // Restart listening if still in voice mode
        if (this.isVoiceModeActive) {
            this.startVoiceRecognition();
        }
    }

    onSpeechError() {
        console.error('Speech playback or generation error occurred.');
        this.currentAudio = null; // Clear reference
        this.isAgentSpeaking = false;
         this.voiceStatusText = 'Audio playback error.';
        // Optionally restart listening after an error? Or require user action?
         if (this.isVoiceModeActive) {
             // Maybe wait a bit longer after an error before restarting
             setTimeout(() => this.startVoiceRecognition(), 1000);
         }
    }

    stopAudioPlayback() {
        if (this.currentAudio) {
             try {
                 // Remove event listeners *before* pausing/resetting
                 this.currentAudio.removeEventListener('ended', this.onSpeechEnd);
                 this.currentAudio.removeEventListener('error', this.onSpeechError);
                 this.currentAudio.pause();
                 this.currentAudio.src = ''; // Detach source
                 this.currentAudio = null;
                 console.log('Stopped previous audio playback.');
             } catch (e) {
                 console.error('Error stopping audio:', e);
             }
        }
        // Also cancel any browser native speech synthesis just in case
        if ('speechSynthesis' in window) {
            window.speechSynthesis.cancel();
        }
    }

    // User clicked "Interrupt" button during TTS
    interruptAgentSpeech() {
        console.log('User interrupted agent speech.');
        this.stopAudioPlayback();
        // `onSpeechEnd` should handle restarting listening if appropriate
         this.onSpeechEnd();
    }


    // --- Drag and Drop Functionality ---
    handleHeaderMouseDown(event) {
        if (this.isExpanded || event.button !== 0) return; // Only drag when not expanded, left-click only
        event.preventDefault(); // Prevent text selection

        this.isDragging = true;
        const chatWindow = this.template.querySelector('.chat-window');
        chatWindow.classList.add('dragging');

        const rect = chatWindow.getBoundingClientRect();
        this.windowStartX = rect.left;
        this.windowStartY = rect.top;
        this.dragStartX = event.clientX;
        this.dragStartY = event.clientY;

        // Add temporary move/up listeners to window
        window.addEventListener('mousemove', this.handleWindowMouseMove);
        window.addEventListener('mouseup', this.handleWindowMouseUp);
    }

    handleHeaderTouchStart(event) {
        if (this.isExpanded || event.touches.length !== 1) return;
        event.preventDefault(); // Prevent page scroll

        this.isDragging = true;
        const chatWindow = this.template.querySelector('.chat-window');
        chatWindow.classList.add('dragging');

        const rect = chatWindow.getBoundingClientRect();
        this.windowStartX = rect.left;
        this.windowStartY = rect.top;
        const touch = event.touches[0];
        this.dragStartX = touch.clientX;
        this.dragStartY = touch.clientY;

        window.addEventListener('touchmove', this.handleWindowTouchMove, { passive: false });
        window.addEventListener('touchend', this.handleWindowTouchEnd);
        window.addEventListener('touchcancel', this.handleWindowTouchEnd);
    }

    // Bound handler references for easy removal
    handleWindowMouseMove = (event) => {
        if (!this.isDragging) return;
        const deltaX = event.clientX - this.dragStartX;
        const deltaY = event.clientY - this.dragStartY;
        const newX = this.windowStartX + deltaX;
        const newY = this.windowStartY + deltaY;
        // Use transform for smoother dragging
        this.template.querySelector('.chat-window').style.transform = `translate(${deltaX}px, ${deltaY}px)`;
    };

    handleWindowMouseUp = (event) => {
        if (!this.isDragging || event.button !== 0) return;
        this.finalizeDrag();
        window.removeEventListener('mousemove', this.handleWindowMouseMove);
        window.removeEventListener('mouseup', this.handleWindowMouseUp);
    };

     handleWindowTouchMove = (event) => {
         if (!this.isDragging || event.touches.length !== 1) return;
          event.preventDefault(); // Prevent scroll during drag
         const touch = event.touches[0];
         const deltaX = touch.clientX - this.dragStartX;
         const deltaY = touch.clientY - this.dragStartY;
         this.template.querySelector('.chat-window').style.transform = `translate(${deltaX}px, ${deltaY}px)`;
     };

    handleWindowTouchEnd = (event) => {
        if (!this.isDragging) return;
        this.finalizeDrag();
        window.removeEventListener('touchmove', this.handleWindowTouchMove);
        window.removeEventListener('touchend', this.handleWindowTouchEnd);
        window.removeEventListener('touchcancel', this.handleWindowTouchEnd);
    };

    finalizeDrag() {
        this.isDragging = false;
        const chatWindow = this.template.querySelector('.chat-window');
        chatWindow.classList.remove('dragging');

        // Get final position from transform
        const transform = chatWindow.style.transform;
        let finalX = this.windowStartX;
        let finalY = this.windowStartY;
        if (transform && transform.includes('translate')) {
            const match = transform.match(/translate\(\s*(-?\d+(\.?\d*)?)px,\s*(-?\d+(\.?\d*)?)px\)/);
            if (match) {
                finalX += parseFloat(match[1]);
                finalY += parseFloat(match[3]);
            }
        }
        chatWindow.style.transform = ''; // Reset transform
        this.updateWindowPositionStyle(null, finalX, finalY); // Apply as top/left
        // Update start position for next potential drag
        this.windowStartX = finalX;
        this.windowStartY = finalY;
    }

     // Applies position using top/left for persistence after drag
     updateWindowPositionStyle(positionName, x, y) {
         const style = {};
         if (x !== undefined && y !== undefined) {
             style.left = `${x}px`;
             style.top = `${y}px`;
             style.right = 'auto';
             style.bottom = 'auto';
         } else if (positionName) {
              // Reset to named position defaults (approximated)
              const defaults = {
                  'bottom-right': { bottom: '30px', right: '30px', left: 'auto', top: 'auto' },
                  'bottom-left': { bottom: '30px', left: '30px', right: 'auto', top: 'auto' },
                  'top-right': { top: '30px', right: '30px', left: 'auto', bottom: 'auto' },
                  'top-left': { top: '30px', left: '30px', right: 'auto', bottom: 'auto' }
              };
              Object.assign(style, defaults[positionName] || defaults['bottom-right']);
         }
         this.chatWindowStyle = Object.entries(style).map(([k, v]) => `${k}:${v}`).join(';');
     }


    // --- Utility Functions ---

    addWindowListeners() {
        // Note: Drag listeners are added dynamically on mousedown/touchstart
        window.addEventListener('resize', this.handleWindowResize);
    }

    removeWindowListeners() {
        window.removeEventListener('resize', this.handleWindowResize);
         // Ensure drag listeners are removed if component disconnects mid-drag
         window.removeEventListener('mousemove', this.handleWindowMouseMove);
         window.removeEventListener('mouseup', this.handleWindowMouseUp);
         window.removeEventListener('touchmove', this.handleWindowTouchMove);
         window.removeEventListener('touchend', this.handleWindowTouchEnd);
         window.removeEventListener('touchcancel', this.handleWindowTouchEnd);
         if (this.outsideClickListener) {
            document.removeEventListener('click', this.outsideClickListener);
        }
    }

    handleWindowResize = () => {
         // Debounce resize handling
         clearTimeout(this.resizeTimeout);
         this.resizeTimeout = setTimeout(() => {
             if (!this.isExpanded) {
                 // Optional: Adjust window position if it goes off-screen after resize
                 // This requires more complex logic to check boundaries
             }
         }, DEBOUNCE_DELAY);
    }

    scrollToBottom() {
        // Queue scroll to end of microtask queue to allow DOM updates
        Promise.resolve().then(() => {
            if (this.messageContainerRef) {
                this.messageContainerRef.scrollTop = this.messageContainerRef.scrollHeight;
            }
        });
    }

    autoExpandTextarea() {
        if (!this.textareaRef) return;
        // Temporarily reset height to calculate scrollHeight accurately
        this.textareaRef.style.height = 'auto';
        const scrollHeight = this.textareaRef.scrollHeight;
        // Set new height, capped by max height
        const newHeight = Math.min(scrollHeight, TEXTAREA_MAX_HEIGHT);
        this.textareaRef.style.height = `${newHeight}px`;
         // Add/remove scroll class if needed (handled by CSS overflow: auto)
    }

    loadThemePreference() {
        try {
            const savedTheme = localStorage.getItem('agentforceChatDarkMode');
            this.isDarkMode = savedTheme !== null ? savedTheme === 'true' : this.defaultDarkMode;
            this.updateTheme();
        } catch (e) {
            console.warn('Could not access localStorage for theme preference.', e);
            this.isDarkMode = this.defaultDarkMode;
             this.updateTheme();
        }
    }

    saveThemePreference() {
        try {
            localStorage.setItem('agentforceChatDarkMode', this.isDarkMode);
        } catch (e) {
            console.warn('Could not save theme preference to localStorage.', e);
        }
    }

    updateTheme() {
        const chatWindow = this.template.querySelector('.chat-window');
        if (chatWindow) {
            chatWindow.classList.toggle('dark-mode', this.isDarkMode);
        }
         // Update body class if needed for global dark mode styles (optional)
         // document.body.classList.toggle('agentforce-dark-mode', this.isDarkMode);
    }

    showToast(title, message, variant = 'info', mode = 'dismissable') {
        this.dispatchEvent(new ShowToastEvent({ title, message, variant, mode }));
    }

    showConfigError(message) {
         this.clearMessages();
         this.addSystemMessage(`Configuration Error: ${message}`, 'config_error', false, true);
         this.componentState = 'error';
         this.showChatWindow = true; // Ensure window is visible to show error
         this.showChatBubble = false;
    }

     showInitializationError(message) {
         // Assuming connecting message might exist, replace it or add new
         this.removeSystemMessageById('init_connect');
         this.addSystemMessage(`Connection Failed: ${message}`, 'init_error', false, true);
         this.addSystemMessage(CONNECTION_ERROR_TEXT, 'init_fail_info', false, true);
         this.componentState = 'error';
     }

    getErrorMessage(error) {
        console.log('Raw error:', JSON.stringify(error)); // Log raw error
        if (!error) return 'Unknown error';
        // Check for AuraHandledException structure first
        if (error.body && typeof error.body.message === 'string') {
            return error.body.message;
        }
        // Check for standard JS Error
        if (typeof error.message === 'string') {
            return error.message;
        }
         // Check for Apex callout errors passed via body text
         if (error.body && typeof error.body === 'string') {
             return error.body;
         }
         // Check for statusText from Fetch API like responses
         if (typeof error.statusText === 'string' && error.status) {
             return `(${error.status}) ${error.statusText}`;
         }
        // Fallback
        return JSON.stringify(error); // Return stringified object if unsure
    }

     stripHtml(html) {
         if (!html) return '';
         try {
             const doc = new DOMParser().parseFromString(html, 'text/html');
             return doc.body.textContent || "";
         } catch (e) {
             console.error('Error stripping HTML:', e);
             // Basic fallback regex (less reliable)
             return html.replace(/<[^>]*>?/gm, '');
         }
     }

    // --- Getters for Template ---

    get containerClasses() {
        return `agent-chat-container position-${this.position}`;
    }

    get chatWindowClasses() {
        let classes = 'chat-window';
        if (this.isExpanded) classes += ' expanded';
        if (this.isDarkMode) classes += ' dark-mode';
        if (this.isDragging) classes += ' dragging';
        if (this.showChatWindow && this.isInitialized) classes += ' loaded'; // For initial animation
        return classes;
    }

     get chatEndedClasses() {
        return `chat-ended ${this.isDarkMode ? 'dark-mode' : ''}`;
     }

    get isInputDisabled() {
        return this.isAgentTyping || this.isVoiceModeActive || this.isInitializing || !this.isInitialized || this.chatHasEnded;
    }

    get isSendDisabled() {
        return !this.currentMessageText.trim() || this.isInputDisabled;
    }

    // Include message type flags for easier template logic
    get formattedMessages() {
        return this.messages.map(m => ({
            ...m,
             key: m.id // Ensure key for iteration
        }));
    }

    // Options Menu Getters
    get themeIcon() { return this.isDarkMode ? 'utility:daylight' : 'utility:dark_mode'; }
    get themeMenuText() { return this.isDarkMode ? 'Switch to Light Mode' : 'Switch to Dark Mode'; }
    get expandIcon() { return this.isExpanded ? 'utility:contract_alt' : 'utility:expand_alt'; }
    get expandMenuText() { return this.isExpanded ? 'Restore Chat Size' : 'Expand Chat'; }
    get voiceIcon() { return this.isVoiceModeActive ? 'utility:text_format' : 'utility:mic'; }
    get voiceMenuText() { return this.isVoiceModeActive ? 'Switch to Text Mode' : 'Switch to Voice Mode'; }
    get showVoiceModeOption() { return this.allowVoiceMode && this.isVoiceModeAvailable; }

    // Voice Visualizer Getters
    get voiceVisualizerClasses() {
        let classes = 'voice-visualizer-circle';
        if (this.isListeningForInput) classes += ' listening';
        if (this.isAgentSpeaking) classes += ' speaking';
        return classes;
    }
    get voiceInputIcon() {
        return this.isAgentSpeaking ? 'utility:volume_high' : 'utility:mic';
    }

    // --- Thinking Process Toggle ---
     toggleThinkingProcess(event) {
         const messageId = event.currentTarget.dataset.id;
         const contentElement = this.template.querySelector(`.thinking-process-content[data-id="${messageId}"]`);
         const iconElement = event.currentTarget.querySelector('.thinking-toggle-icon');
         if (contentElement && iconElement) {
             const isExpanded = contentElement.classList.toggle('expanded');
             iconElement.classList.toggle('expanded', isExpanded);
             // Ensure scroll position is maintained or adjusted after toggle
             this.scrollToBottom();
         }
     }
}
// --- END OF FILE agentChat.js ---
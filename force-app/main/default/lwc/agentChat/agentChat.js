import { LightningElement, track, api } from 'lwc';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';
import initializeAgentSession from '@salesforce/apex/AgentChatController.initializeAgentSession'; // Corrected controller name if needed
import getAgentRecommendation from '@salesforce/apex/AgentChatController.getAgentRecommendation';
import endAgentSession from '@salesforce/apex/AgentChatController.endAgentSession';
import callElevenLabsTTS from '@salesforce/apex/ElevenLabsTTSController.generateSpeech';

// Constants
const USER_SENDER = 'user';
const AGENT_SENDER = 'agent';
const SYSTEM_SENDER = 'system';
const DEBOUNCE_DELAY = 300;
const TEXTAREA_MAX_HEIGHT = 100;
const TYPING_INDICATOR_TEXT = 'Agent is thinking...';
const CONNECTING_TEXT = 'Connecting to Agentforce...';
const RECONNECTING_TEXT = 'Reconnecting...';
const CONNECTION_ERROR_TEXT = "Sorry, I couldn't connect right now. Please try again later.";
const DEFAULT_VOICE_ID = '21m00Tcm4TlvDq8ikWAM'; // Default ElevenLabs Voice ID (Rachel)

export default class MessengerChat extends LightningElement {
    // --- Component Properties (from metadata) ---
    @api agentName = 'Agentforce';
    @api agentId;
    @api connectedAppConsumerKey;
    @api connectedAppConsumerSecret;
    @api defaultDarkMode = false;
    @api welcomeMessage = 'Hello! How can I assist you today?';
    @api allowVoiceMode = true;
    @api position = 'bottom-right';
    @api headerText = 'Agentforce Support';
    @api elevenLabsApiKey;
    @api elevenLabsVoiceId = DEFAULT_VOICE_ID;

    // --- Reactive State Variables ---
    @track messages = [];
    @track currentMessageText = '';
    @track isDarkMode = false;
    @track showChatBubble = true;
    @track showChatWindow = false;
    @track chatHasEnded = false;
    @track showEndChatModal = false;
    // @track showOptionsMenu = false; // REMOVED
    // @track isExpanded = false; // REMOVED
    @track isAgentTyping = false;
    @track componentState = 'minimized';
    @track chatWindowStyle = '';
    @track showWelcomeBanner = true; // NEW state for welcome banner

    // --- Voice Mode State ---
    @track isVoiceModeAvailable = false;
    @track isVoiceModeActive = false;
    @track isListeningForInput = false;
    @track isAgentSpeaking = false;
    @track voiceStatusText = '';

    // --- Internal Component State ---
    sessionId = null;
    isInitialized = false;
    isInitializing = false;
    isSessionEnding = false;
    initialWelcomeMessageSent = false;
    lastMessageId = 0;
    textareaRef = null;
    messageContainerRef = null;
    currentAudio = null;
    recognition = null;
    isDragging = false;
    dragStartX = 0; dragStartY = 0; windowStartX = 0; windowStartY = 0;
    resizeTimeout;
    // outsideClickListener; // REMOVED

    // --- Lifecycle Hooks ---
    connectedCallback() {
        this.loadThemePreference();
        this.componentState = 'minimized';
        this.showWelcomeBanner = true; // Show banner initially
        this.checkVoiceSupport();
        this.addWindowListeners();
        this.updateWindowPositionStyle(this.position);
    }

    renderedCallback() {
        this.textareaRef = this.refs.textarea;
        this.messageContainerRef = this.refs.messageContainer;
        if (this.showChatWindow) {
            this.scrollToBottom();
            this.renderAgentMessagesWithHTML();
        }
        if(this.showChatWindow && !this.template.querySelector('.chat-window.loaded')){
             const windowEl = this.template.querySelector('.chat-window');
             if(windowEl) windowEl.classList.add('loaded');
        }
    }

    disconnectedCallback() {
        this.removeWindowListeners();
        this.endChatSessionInternal(false);
        this.stopAudioPlayback();
        this.stopVoiceRecognition();
        // if (this.outsideClickListener) document.removeEventListener('click', this.outsideClickListener); // REMOVED
    }

    // --- Initialization and Session Management ---
    async initializeChatSession() {
        if (this.isInitializing || this.isInitialized) return;
        if (!this.agentId || !this.connectedAppConsumerKey || !this.connectedAppConsumerSecret) {
            this.showConfigError('Configuration incomplete. Please provide Agent ID, Consumer Key, and Consumer Secret.');
            return;
        }
        console.log('Initializing Agentforce session...');
        this.isInitializing = true; this.isInitialized = false; this.componentState = 'initializing'; this.sessionId = null;
        this.clearMessages();
        this.addSystemMessage(CONNECTING_TEXT, 'init_connect');

        try {
            const result = await initializeAgentSession({
                agentId: this.agentId,
                consumerKey: this.connectedAppConsumerKey,
                consumerSecret: this.connectedAppConsumerSecret
            });
            if (result) {
                console.log('Session initialized successfully. Session ID:', result);
                this.sessionId = result; this.isInitialized = true;
                this.removeSystemMessageById('init_connect'); this.componentState = 'active';
                if (!this.initialWelcomeMessageSent && this.welcomeMessage) {
                     this.addAgentMessage(this.welcomeMessage, true);
                     this.initialWelcomeMessageSent = true;
                } else if (!this.initialWelcomeMessageSent) {
                    console.log('No welcome message configured, sending "Hello" to agent.');
                    this.getUserAgentResponse('Hello');
                    this.initialWelcomeMessageSent = true;
                }
            } else { throw new Error('Session initialization returned no Session ID.'); }
        } catch (error) {
            console.error('Error initializing Agentforce session:', error);
            this.removeSystemMessageById('init_connect');
            this.showInitializationError(this.getErrorMessage(error));
             this.componentState = 'error';
        } finally { this.isInitializing = false; }
    }

    async confirmEndChat() {
        this.showEndChatModal = false;
        await this.endChatSessionInternal(true);
    }

    async endChatSessionInternal(showUserMessage) {
        if (this.isSessionEnding || !this.sessionId) { this.resetChatUI(); return; }
        console.log('Ending chat session:', this.sessionId);
        this.isSessionEnding = true; this.stopAudioPlayback(); this.stopVoiceRecognition();
        if (this.isVoiceModeActive) this.toggleVoiceInput(); // Exit voice mode UI
        if (showUserMessage) this.addSystemMessage('Ending conversation...');

        try {
            await endAgentSession({ sessionId: this.sessionId, consumerKey: this.connectedAppConsumerKey, consumerSecret: this.connectedAppConsumerSecret });
            console.log('Agent session ended successfully via API.');
        } catch (error) {
            console.error('Error ending agent session via API:', error);
            this.showToast('Error', 'Could not formally end the agent session: ' + this.getErrorMessage(error), 'error');
        } finally {
            this.sessionId = null; this.isInitialized = false; this.isSessionEnding = false; this.initialWelcomeMessageSent = false;
            if (showUserMessage) {
                this.chatHasEnded = true; this.showChatWindow = false; this.showChatBubble = false; this.componentState = 'ended';
            } else { this.resetChatUI(); }
        }
    }

    resetChatUI() {
        this.showChatWindow = false; this.showChatBubble = true; this.chatHasEnded = false;
        // this.isExpanded = false; // REMOVED
        this.messages = []; this.componentState = 'minimized';
        this.showWelcomeBanner = true; // Show banner again when minimized
        this.updateWindowPositionStyle(this.position);
         const chatWindow = this.template.querySelector('.chat-window');
         if (chatWindow) {
             chatWindow.classList.remove('dragging', 'loaded'); // Removed 'expanded'
             chatWindow.style.transform = '';
         }
    }

    startNewChat() { this.resetChatUI(); }

    // --- Message Handling ---
    handleMessageChange(event) { this.currentMessageText = event.target.value; this.autoExpandTextarea(); }
    handleKeyPress(event) { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); this.sendMessage(); } this.autoExpandTextarea(); }

    sendMessage() {
        const textToSend = this.currentMessageText.trim();
        if (!textToSend || this.isInputDisabled) return;
        console.log('Sending message:', textToSend);
        this.addUserMessage(textToSend);
        this.getUserAgentResponse(textToSend);
        this.currentMessageText = '';
        if (this.textareaRef) { this.textareaRef.value = ''; this.textareaRef.style.height = 'auto'; }
    }

    async getUserAgentResponse(messageText) {
        if (this.isAgentTyping || !this.sessionId) return;
        this.isAgentTyping = true;
        const typingMsgId = this.addSystemMessage(TYPING_INDICATOR_TEXT, null, true);

        try {
            const response = await getAgentRecommendation({ sessionId: this.sessionId, message: messageText, consumerKey: this.connectedAppConsumerKey, consumerSecret: this.connectedAppConsumerSecret });
            this.removeSystemMessageById(typingMsgId);
            if (response) {
                console.log('Agent response received.');
                this.addAgentMessage(response, true);
                if (this.isVoiceModeActive) this.speakAgentResponse(response);
            } else {
                 console.log('Agent returned an empty response.');
                 this.addAgentMessage("I'm sorry, I could not find an answer for that.", false);
                 if (this.isVoiceModeActive) this.speakAgentResponse("I'm sorry, I could not find an answer for that.");
            }
        } catch (error) {
            console.error('Error getting agent recommendation:', error);
            this.removeSystemMessageById(typingMsgId);
            const errorMsg = this.getErrorMessage(error);
             if (error.body?.message?.includes('expired') || error.body?.message?.includes('invalid') || error.status === 404 || error.message?.includes('404')) {
                 console.warn('Session likely expired. Attempting to re-initialize.');
                 this.addSystemMessage('Session expired. Reconnecting...');
                 this.isInitialized = false; this.sessionId = null;
                 await this.initializeChatSession();
                 if(this.isInitialized) {
                     console.log('Re-initialization successful, resending message.');
                     this.getUserAgentResponse(messageText);
                 } else { this.addSystemMessage("Failed to reconnect. Please start a new chat."); }
             } else { this.addSystemMessage(`Error: ${errorMsg}`, null, false, true); }
        } finally { this.isAgentTyping = false; }
    }

    addMessage(text, sender, id = null, isTyping = false, isError = false, isRawHtml = false) {
        if (!text && !isTyping) return;
        const messageId = id || `msg_${++this.lastMessageId}`;
        const timestamp = this.getTimestamp();
        let cssClass = `message ${sender}-message`;
        if (isTyping) cssClass += ' typing-message';
        if (isError) cssClass += ' error-message';

        const messageObj = {
            id: messageId, sender: sender, text: text, timestamp: timestamp, cssClass: cssClass,
            isUserMessage: sender === USER_SENDER, isAgentMessage: sender === AGENT_SENDER, isSystemMessage: sender === SYSTEM_SENDER,
            isTypingMessage: isTyping, isErrorMessage: isError, rawHtml: isRawHtml && sender === AGENT_SENDER && !isTyping,
            thinkingProcess: null, hasThinkingProcess: false };

         if (messageObj.isAgentMessage && !messageObj.isTypingMessage && messageObj.text) {
             const thinkTagRegex = /<think>([\s\S]*?)<\/think>/i;
             const match = messageObj.text.match(thinkTagRegex);
             if (match && match[1]) {
                 messageObj.thinkingProcess = match[1].trim();
                 messageObj.hasThinkingProcess = true;
                 messageObj.text = messageObj.text.replace(thinkTagRegex, '').trim();
                 console.log(`Extracted thinking process for message ${messageId}`);
             }
         }
        this.messages = [...this.messages, messageObj];
        this.scrollToBottom();
        return messageId;
    }
    addUserMessage(text) { this.addMessage(text, USER_SENDER); }
    addAgentMessage(text, isRawHtml = false) { this.addMessage(text, AGENT_SENDER, null, false, false, isRawHtml); }
    addSystemMessage(text, id = null, isTyping = false, isError = false) { return this.addMessage(text, SYSTEM_SENDER, id, isTyping, isError); }
    removeSystemMessageById(id) { if (!id) return; this.messages = this.messages.filter(m => m.id !== id); }
    clearMessages() { this.messages = []; this.lastMessageId = 0; }
    getTimestamp() { return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }); }

    renderAgentMessagesWithHTML() {
        this.messages.forEach(message => {
            if (message.rawHtml && message.isAgentMessage) {
                const container = this.template.querySelector(`.lwc-manual-render[data-id="${message.id}"]`);
                if (container && !container.dataset.rendered) {
                    try {
                        let sanitizedHtml = message.text.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
                        container.innerHTML = sanitizedHtml;
                        container.dataset.rendered = 'true';
                         this.enhanceRenderedHTML(container);
                    } catch (e) { console.error(`Error rendering HTML for message ${message.id}:`, e); container.textContent = '[Error displaying content]'; }
                }
            }
        });
    }
     enhanceRenderedHTML(container) {
         const links = container.querySelectorAll('a');
         links.forEach(link => { link.target = '_blank'; link.rel = 'noopener noreferrer'; });
     }

    // --- UI Event Handlers ---
    handleChatBubbleClick() {
        console.log('Chat bubble clicked');
        this.showChatBubble = false;
        this.showChatWindow = true;
        this.showWelcomeBanner = false; // Hide banner when chat opens
        this.componentState = 'initializing';
        requestAnimationFrame(() => { this.textareaRef?.focus(); });
        this.initializeChatSession();
    }

    handleMinimizeToBubble() {
        console.log('Minimizing to bubble');
        this.showChatWindow = false;
        this.showChatBubble = true;
        // this.showOptionsMenu = false; // REMOVED
        this.componentState = 'minimized';
        this.showWelcomeBanner = true; // Show banner again when minimized
        this.stopAudioPlayback();
        this.stopVoiceRecognition();
         if (this.isVoiceModeActive) this.toggleVoiceInput();
    }

    // handleToggleExpand() { // REMOVED
    // }

    handleToggleTheme() {
        this.isDarkMode = !this.isDarkMode;
        this.updateTheme();
        this.saveThemePreference();
        // this.showOptionsMenu = false; // REMOVED
    }

    // toggleOptionsMenu() { // REMOVED
    // }
    // handleOutsideClick(event) { // REMOVED
    // }
    // handleMenuClick(event) { // REMOVED
    // }

    showEndChatConfirmation() {
        this.stopAudioPlayback();
        this.showEndChatModal = true;
        // this.showOptionsMenu = false; // REMOVED
    }

    cancelEndChat() { this.showEndChatModal = false; }

    dismissWelcomeBanner() { this.showWelcomeBanner = false; } // NEW handler for banner close

    // --- Voice Mode Handling ---
    checkVoiceSupport() {
        this.isVoiceModeAvailable = ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window) && ('speechSynthesis' in window);
         if (!this.isVoiceModeAvailable) console.warn('Voice Recognition or Speech Synthesis not supported.');
    }

    handleToggleVoiceMode() {
         if (!this.isVoiceModeAvailable) {
             this.showToast('Not Supported', 'Voice mode is not available in your browser.', 'warning');
             return;
         }
        this.toggleVoiceInput();
        // this.showOptionsMenu = false; // REMOVED
    }

    toggleVoiceInput() {
         if (this.isVoiceModeActive) {
             console.log('Turning Voice Mode OFF');
             this.isVoiceModeActive = false; this.isListeningForInput = false; this.isAgentSpeaking = false; this.voiceStatusText = '';
             this.stopAudioPlayback(); this.stopVoiceRecognition();
             if (this.textareaRef) this.textareaRef.disabled = false;
         } else {
             console.log('Turning Voice Mode ON');
             this.isVoiceModeActive = true; this.isAgentSpeaking = false;
             if (this.textareaRef) this.textareaRef.disabled = true;
             this.startVoiceRecognition();
         }
    }

    startVoiceRecognition() {
        if (!this.isVoiceModeAvailable || !this.isVoiceModeActive || this.isListeningForInput) return;
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!this.recognition) {
            this.recognition = new SpeechRecognition();
            this.recognition.continuous = false; this.recognition.interimResults = false; this.recognition.lang = 'en-US';
            this.recognition.onstart = () => { console.log('Voice recognition started.'); this.isListeningForInput = true; this.voiceStatusText = 'Listening...'; };
            this.recognition.onresult = (event) => {
                 const transcript = event.results[event.results.length - 1][0].transcript.trim();
                 console.log('Voice result (final):', transcript);
                 if (transcript) {
                     this.isListeningForInput = false; this.voiceStatusText = 'Processing...';
                     this.addUserMessage(transcript); this.getUserAgentResponse(transcript);
                 } else {
                       this.voiceStatusText = 'Did not hear anything.';
                       setTimeout(() => this.startVoiceRecognition(), 500);
                 }
            };
            this.recognition.onerror = (event) => {
                console.error('Speech recognition error:', event.error, event.message);
                this.isListeningForInput = false;
                 let errorMsg = 'Voice recognition error';
                 if (event.error === 'no-speech') { errorMsg = 'No speech detected. Try again.'; setTimeout(() => this.startVoiceRecognition(), 500); }
                 else if (event.error === 'audio-capture') { errorMsg = 'Microphone error. Check permissions.'; this.toggleVoiceInput(); }
                 else if (event.error === 'not-allowed') { errorMsg = 'Microphone access denied.'; this.toggleVoiceInput(); }
                 else { errorMsg = `Error: ${event.error}`; }
                 this.voiceStatusText = errorMsg;
            };
            this.recognition.onend = () => {
                console.log('Voice recognition ended.'); this.isListeningForInput = false;
                if (this.isVoiceModeActive && !this.isAgentSpeaking && !this.isAgentTyping) {
                     console.log('Recognition ended, restarting listening...');
                     setTimeout(() => this.startVoiceRecognition(), 100);
                 } else { console.log('Recognition ended, not restarting.'); }
            };
        }
         try { this.recognition.start(); }
         catch (e) {
              console.warn('Recognition start attempted but may have already been active:', e.message);
              if(!this.isListeningForInput) { this.isListeningForInput = true; this.voiceStatusText = 'Listening...'; }
         }
    }

    stopVoiceRecognition() {
        if (this.recognition) {
            try { this.recognition.stop(); console.log('Voice recognition stopped.'); }
            catch (e) { console.warn('Error stopping voice recognition:', e); }
            this.isListeningForInput = false;
        }
    }

    async speakAgentResponse(responseText) {
        if (!this.isVoiceModeActive || !this.elevenLabsApiKey) return;
        this.isAgentSpeaking = true; this.voiceStatusText = 'Agent is speaking...'; this.stopVoiceRecognition();
        const cleanText = this.stripHtml(responseText).replace(/<think>[\s\S]*?<\/think>/i, '').trim();
        if (!cleanText) { console.log('No text content to speak after cleaning.'); this.onSpeechEnd(); return; }
        console.log('Requesting speech from ElevenLabs for:', cleanText.substring(0, 50) + '...');

        try {
            this.stopAudioPlayback();
            const dataUri = await callElevenLabsTTS({ text: cleanText, elevenLabsApiKey: this.elevenLabsApiKey, voiceId: this.elevenLabsVoiceId || DEFAULT_VOICE_ID });
            if (dataUri) {
                console.log('Received audio Data URI from ElevenLabs.');
                this.currentAudio = new Audio(dataUri);
                this.currentAudio.addEventListener('ended', this.onSpeechEnd.bind(this));
                this.currentAudio.addEventListener('error', this.onSpeechError.bind(this));
                this.currentAudio.play().catch(e => { console.error('Error playing ElevenLabs audio:', e); this.onSpeechError(); });
            } else { throw new Error('ElevenLabs returned empty audio data.'); }
        } catch (error) {
            console.error('Error generating/playing ElevenLabs speech:', error);
            this.showToast('TTS Error', 'Could not play agent response: ' + this.getErrorMessage(error), 'error');
            this.onSpeechError();
        }
    }

    onSpeechEnd() {
        console.log('Speech playback ended.'); this.currentAudio = null; this.isAgentSpeaking = false;
        if (this.isVoiceModeActive) this.startVoiceRecognition();
    }
    onSpeechError() {
        console.error('Speech playback or generation error occurred.'); this.currentAudio = null; this.isAgentSpeaking = false; this.voiceStatusText = 'Audio playback error.';
        if (this.isVoiceModeActive) setTimeout(() => this.startVoiceRecognition(), 1000);
    }
    stopAudioPlayback() {
        if (this.currentAudio) {
             try {
                 this.currentAudio.removeEventListener('ended', this.onSpeechEnd);
                 this.currentAudio.removeEventListener('error', this.onSpeechError);
                 this.currentAudio.pause(); this.currentAudio.src = ''; this.currentAudio = null;
                 console.log('Stopped previous audio playback.');
             } catch (e) { console.error('Error stopping audio:', e); }
        }
        if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    }
    interruptAgentSpeech() {
        console.log('User interrupted agent speech.'); this.stopAudioPlayback(); this.onSpeechEnd();
    }

    // --- Drag and Drop Functionality ---
    handleHeaderMouseDown(event) {
        // if (this.isExpanded || event.button !== 0) return; // REMOVED isExpanded check
        if (event.button !== 0) return; // Only left-click
        event.preventDefault();
        this.isDragging = true;
        const chatWindow = this.template.querySelector('.chat-window');
        chatWindow.classList.add('dragging');
        const rect = chatWindow.getBoundingClientRect();
        this.windowStartX = rect.left; this.windowStartY = rect.top;
        this.dragStartX = event.clientX; this.dragStartY = event.clientY;
        window.addEventListener('mousemove', this.handleWindowMouseMove);
        window.addEventListener('mouseup', this.handleWindowMouseUp);
    }
    handleHeaderTouchStart(event) {
        // if (this.isExpanded || event.touches.length !== 1) return; // REMOVED isExpanded check
        if (event.touches.length !== 1) return;
        event.preventDefault();
        this.isDragging = true;
        const chatWindow = this.template.querySelector('.chat-window');
        chatWindow.classList.add('dragging');
        const rect = chatWindow.getBoundingClientRect();
        this.windowStartX = rect.left; this.windowStartY = rect.top;
        const touch = event.touches[0];
        this.dragStartX = touch.clientX; this.dragStartY = touch.clientY;
        window.addEventListener('touchmove', this.handleWindowTouchMove, { passive: false });
        window.addEventListener('touchend', this.handleWindowTouchEnd);
        window.addEventListener('touchcancel', this.handleWindowTouchEnd);
    }
    handleWindowMouseMove = (event) => {
        if (!this.isDragging) return;
        const deltaX = event.clientX - this.dragStartX; const deltaY = event.clientY - this.dragStartY;
        this.template.querySelector('.chat-window').style.transform = `translate(${deltaX}px, ${deltaY}px)`;
    };
    handleWindowMouseUp = (event) => {
        if (!this.isDragging || event.button !== 0) return; this.finalizeDrag();
        window.removeEventListener('mousemove', this.handleWindowMouseMove); window.removeEventListener('mouseup', this.handleWindowMouseUp);
    };
     handleWindowTouchMove = (event) => {
         if (!this.isDragging || event.touches.length !== 1) return; event.preventDefault();
         const touch = event.touches[0]; const deltaX = touch.clientX - this.dragStartX; const deltaY = touch.clientY - this.dragStartY;
         this.template.querySelector('.chat-window').style.transform = `translate(${deltaX}px, ${deltaY}px)`;
     };
    handleWindowTouchEnd = (event) => {
        if (!this.isDragging) return; this.finalizeDrag();
        window.removeEventListener('touchmove', this.handleWindowTouchMove); window.removeEventListener('touchend', this.handleWindowTouchEnd); window.removeEventListener('touchcancel', this.handleWindowTouchEnd);
    };
    finalizeDrag() {
        this.isDragging = false; const chatWindow = this.template.querySelector('.chat-window'); chatWindow.classList.remove('dragging');
        const transform = chatWindow.style.transform; let finalX = this.windowStartX; let finalY = this.windowStartY;
        if (transform && transform.includes('translate')) {
            const match = transform.match(/translate\(\s*(-?\d+(\.?\d*)?)px,\s*(-?\d+(\.?\d*)?)px\)/);
            if (match) { finalX += parseFloat(match[1]); finalY += parseFloat(match[3]); }
        }
        chatWindow.style.transform = ''; this.updateWindowPositionStyle(null, finalX, finalY);
        this.windowStartX = finalX; this.windowStartY = finalY;
    }
     updateWindowPositionStyle(positionName, x, y) {
         const style = {};
         if (x !== undefined && y !== undefined) { style.left = `${x}px`; style.top = `${y}px`; style.right = 'auto'; style.bottom = 'auto'; }
         else if (positionName) {
              const defaults = { 'bottom-right': { bottom: '30px', right: '30px', left: 'auto', top: 'auto' }, 'bottom-left': { bottom: '30px', left: '30px', right: 'auto', top: 'auto' }, 'top-right': { top: '30px', right: '30px', left: 'auto', bottom: 'auto' }, 'top-left': { top: '30px', left: '30px', right: 'auto', bottom: 'auto' } };
              Object.assign(style, defaults[positionName] || defaults['bottom-right']);
         }
         this.chatWindowStyle = Object.entries(style).map(([k, v]) => `${k}:${v}`).join(';');
     }

    // --- Utility Functions ---
    addWindowListeners() { window.addEventListener('resize', this.handleWindowResize); }
    removeWindowListeners() {
        window.removeEventListener('resize', this.handleWindowResize);
        window.removeEventListener('mousemove', this.handleWindowMouseMove); window.removeEventListener('mouseup', this.handleWindowMouseUp);
        window.removeEventListener('touchmove', this.handleWindowTouchMove); window.removeEventListener('touchend', this.handleWindowTouchEnd); window.removeEventListener('touchcancel', this.handleWindowTouchEnd);
        // if (this.outsideClickListener) document.removeEventListener('click', this.outsideClickListener); // REMOVED
    }
    handleWindowResize = () => { clearTimeout(this.resizeTimeout); this.resizeTimeout = setTimeout(() => {}, DEBOUNCE_DELAY); } // Removed resize logic for simplicity
    scrollToBottom() { Promise.resolve().then(() => { if (this.messageContainerRef) this.messageContainerRef.scrollTop = this.messageContainerRef.scrollHeight; }); }
    autoExpandTextarea() {
        if (!this.textareaRef) return; this.textareaRef.style.height = 'auto'; const scrollHeight = this.textareaRef.scrollHeight;
        const newHeight = Math.min(scrollHeight, TEXTAREA_MAX_HEIGHT); this.textareaRef.style.height = `${newHeight}px`;
    }
    loadThemePreference() {
        try { const savedTheme = localStorage.getItem('agentforceChatDarkMode'); this.isDarkMode = savedTheme !== null ? savedTheme === 'true' : this.defaultDarkMode; this.updateTheme(); }
        catch (e) { console.warn('Could not access localStorage for theme preference.', e); this.isDarkMode = this.defaultDarkMode; this.updateTheme(); }
    }
    saveThemePreference() { try { localStorage.setItem('agentforceChatDarkMode', this.isDarkMode); } catch (e) { console.warn('Could not save theme preference to localStorage.', e); } }
    updateTheme() { const chatWindow = this.template.querySelector('.chat-window'); if (chatWindow) chatWindow.classList.toggle('dark-mode', this.isDarkMode); }
    showToast(title, message, variant = 'info', mode = 'dismissable') { this.dispatchEvent(new ShowToastEvent({ title, message, variant, mode })); }
    showConfigError(message) { this.clearMessages(); this.addSystemMessage(`Configuration Error: ${message}`, 'config_error', false, true); this.componentState = 'error'; this.showChatWindow = true; this.showChatBubble = false; }
    showInitializationError(message) { this.removeSystemMessageById('init_connect'); this.addSystemMessage(`Connection Failed: ${message}`, 'init_error', false, true); this.addSystemMessage(CONNECTION_ERROR_TEXT, 'init_fail_info', false, true); this.componentState = 'error'; }
    getErrorMessage(error) { console.log('Raw error:', JSON.stringify(error)); if (!error) return 'Unknown error'; if (error.body && typeof error.body.message === 'string') return error.body.message; if (typeof error.message === 'string') return error.message; if (error.body && typeof error.body === 'string') return error.body; if (typeof error.statusText === 'string' && error.status) return `(${error.status}) ${error.statusText}`; return JSON.stringify(error); }
    stripHtml(html) { if (!html) return ''; try { const doc = new DOMParser().parseFromString(html, 'text/html'); return doc.body.textContent || ""; } catch (e) { console.error('Error stripping HTML:', e); return html.replace(/<[^>]*>?/gm, ''); } }

    // --- Getters for Template ---
    get containerClasses() { return `messenger-chat-container position-${this.position}`; }
    get chatWindowClasses() {
        let classes = 'chat-window';
        // if (this.isExpanded) classes += ' expanded'; // REMOVED
        if (this.isDarkMode) classes += ' dark-mode';
        if (this.isDragging) classes += ' dragging';
        if (this.showChatWindow && this.isInitialized) classes += ' loaded';
        return classes;
    }
    get chatEndedClasses() { return `chat-ended ${this.isDarkMode ? 'dark-mode' : ''}`; }
    get isInputDisabled() { return this.isAgentTyping || this.isVoiceModeActive || this.isInitializing || !this.isInitialized || this.chatHasEnded; }
    get isSendDisabled() { return !this.currentMessageText.trim() || this.isInputDisabled; }
    get formattedMessages() { return this.messages.map(m => ({ ...m, key: m.id })); }

    // Header Icon Getters
    get themeIcon() { return this.isDarkMode ? 'utility:daylight' : 'utility:dark_mode'; }
    get themeTooltip() { return this.isDarkMode ? 'Switch to Light Mode' : 'Switch to Dark Mode'; }
    get voiceIcon() { return this.isVoiceModeActive ? 'utility:text_format' : 'utility:mic'; } // Swapped icons
    get voiceTooltip() { return this.isVoiceModeActive ? 'Switch to Text Input' : 'Switch to Voice Input'; }
    get showVoiceModeOption() { return this.allowVoiceMode && this.isVoiceModeAvailable; } // Keep logic for conditional rendering

    // Voice Visualizer Getters
    get voiceOverlayClasses() { return `voice-mode-overlay ${this.isVoiceModeActive ? 'active' : ''}`; } // For smooth transition
    get voiceVisualizerClasses() {
        let classes = 'voice-visualizer-circle';
        if (this.isListeningForInput) classes += ' listening';
        if (this.isAgentSpeaking) classes += ' speaking';
        return classes;
    }
    get voiceInputIcon() { return this.isAgentSpeaking ? 'utility:volume_high' : 'utility:mic'; }

    // Thinking Process Toggle
     toggleThinkingProcess(event) {
         const messageId = event.currentTarget.dataset.id;
         const contentElement = this.template.querySelector(`.thinking-process-content[data-id="${messageId}"]`);
         const iconElement = event.currentTarget.querySelector('.thinking-toggle-icon');
         if (contentElement && iconElement) {
             const isExpanded = contentElement.classList.toggle('expanded');
             iconElement.classList.toggle('expanded', isExpanded);
             this.scrollToBottom();
         }
     }
}

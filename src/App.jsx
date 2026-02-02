import React, { useState, useRef, useEffect } from 'react';
import CarelyLogoFull from './assets/carely-logo-full.png';
import CarelyLogoIcon from './assets/carely-logo-icon.png';
import * as pdfjsLib from 'pdfjs-dist';
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;


// Helper function to render text with **bold** markdown
const renderTextWithBold = (text) => {
  if (!text) return null;
  const parts = text.split(/(\*\*.*?\*\*)/g);
  return parts.map((part, index) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={index}>{part.slice(2, -2)}</strong>;
    }
    return part;
  });
};

async function callOpenAI(messages) {
  const response = await fetch('http://localhost:3001/api/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages }),
  });

  const text = await response.text();
let data;

try {
  data = JSON.parse(text);
} catch {
  throw new Error('Backend did not return JSON. Is the server running?');
}


  if (!response.ok || data.error) {
    throw new Error(data.error || 'AI request failed');
  }

  return data.content;
}



// === CARELY QA SYSTEM PROMPT ===
const SYSTEM_PROMPT = `
You are a healthcare quality assurance AI for Carely Health.

Your responsibilities:
- Analyze nurse–patient call transcripts
- Compare nurse statements with discharge instructions
- Identify:
  • Unsafe medical advice
  • Statements outside nursing scope
  • Contradictions to discharge instructions
  • Dismissive or misleading language
- Quote problematic nurse statements
- Explain why each is an issue
- Suggest safer, policy-compliant alternatives

Formatting rules (IMPORTANT):
- Do NOT use markdown headings
- Do NOT use ### or ##
- Use plain text labels like:
  "1. Call Summary:"
  "2. Patient Concerns:"
- Use bullet points with "-" only
- Use **bold** only when emphasis is needed

Content rules:
- Do not diagnose
- Do not invent facts
- Quote problematic nurse statements exactly
- Suggest safer alternatives

Rules:
- Do not diagnose
- Do not invent facts
- If something is not in the transcript, say so
- This is for internal quality review only
`;

const CarelyAIAssistant = () => {
  const [preferredLanguage, setPreferredLanguage] = useState('auto'); // 'auto' | 'en' | 'hi'
// 'auto' | 'en' | 'hi'

  const [activeTab, setActiveTab] = useState('call-logs');
  
  // Call Analysis State
  const [callFile, setCallFile] = useState(null);
  const [callTranscript, setCallTranscript] = useState('');
  const [chatMessages, setChatMessages] = useState([]);
  const [chatInput, setChatInput] = useState('');
  const [isChatLoading, setIsChatLoading] = useState(false);
  
  // Discharge Summary State
  const [dischargeFile, setDischargeFile] = useState(null);
  const [dischargeSummary, setDischargeSummary] = useState('');
  const [careQuestions, setCareQuestions] = useState(null);
  const [isGeneratingQuestions, setIsGeneratingQuestions] = useState(false);
  const [dischargeChatMessages, setDischargeChatMessages] = useState([]);
  const [dischargeChatInput, setDischargeChatInput] = useState('');
  const [isDischargeChatLoading, setIsDischargeChatLoading] = useState(false);
  
  // Voice Assistant State
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessingVoice, setIsProcessingVoice] = useState(false);
  const [voiceMessages, setVoiceMessages] = useState([]);
  const [voiceStatus, setVoiceStatus] = useState('idle');
  
  const chatEndRef = useRef(null);
  const dischargeChatEndRef = useRef(null);
  const callFileInputRef = useRef(null);
  const dischargeFileInputRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);

  // Auto-scroll chat to bottom
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages]);

  useEffect(() => {
    dischargeChatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [dischargeChatMessages]);

  // Handle call log file upload
  const handleCallFileUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    
    setCallFile(file);
    
    if (file.type === 'text/plain' || file.name.endsWith('.txt')) {
      const text = await file.text();
      setCallTranscript(text);
      
      // Auto-start analysis
      setChatMessages([{
        role: 'system',
        content: `📁 Uploaded: ${file.name}`,
        isSystem: true
      }]);
      
      // Trigger initial analysis
      analyzeCallTranscript(text, dischargeSummary);
    } else {
      alert('Please upload a .txt file for call logs');
    }
  };

  // Handle discharge PDF upload
  const handleDischargeFileUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    
    setDischargeFile(file);
    
    if (file.type === 'application/pdf' || file.name.endsWith('.pdf')) {
      // For PDF, we'll use a simple approach - in production you'd use pdf.js or similar
      // For this demo, we'll extract text using the FileReader and show a message
      setCareQuestions(null);
      
      // Read PDF as ArrayBuffer and extract text (basic approach)
      const arrayBuffer = await file.arrayBuffer();
      const text = await extractTextFromPDF(arrayBuffer, file.name);
      setDischargeSummary(text);
      const introRes = await fetch('http://localhost:3001/api/discharge/intro', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ dischargeSummary: text })
});

const introData = await introRes.json();

setDischargeChatMessages([
  { role: 'assistant', content: introData.introText }
]);

      generateCareQuestions(text);

   if (activeTab === 'voice') {
  setVoiceMessages([]);
  setVoiceStatus('playing');

  fetch('http://localhost:3001/api/voice/init', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      dischargeSummary: text,
      preferredLanguage,
    }),
  })
    .then(res => {
      if (!res.ok) throw new Error('Voice init failed');
      return res.json();
    })
    .then(data => {
      setVoiceMessages([
        {
          role: 'assistant',
          content: data.responseText,
          isVoice: true,
        },
      ]);
      playAudioResponse(data.audioBase64);
    })
    .catch(err => {
      setVoiceStatus('idle');
      console.error(err);
    });
}



      
    } else if (file.type === 'text/plain' || file.name.endsWith('.txt')) {
      const text = await file.text();
      setDischargeSummary(text);
generateCareQuestions(text);
    } else {
      alert('Please upload a PDF or TXT file');
    }
  };

  // Basic PDF text extraction (for demo - shows file was uploaded)
const extractTextFromPDF = async (arrayBuffer) => {
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  let fullText = '';

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const pageText = content.items.map(item => item.str).join(' ');
    fullText += pageText + '\n';
  }

  return fullText.trim();
};

  // Analyze call transcript
const analyzeCallTranscript = async (transcript, dischargeSummary) => {
  setIsChatLoading(true);

  try {
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'system',
        content: `Discharge Summary:\n${dischargeSummary || 'Not provided'}`
      },
      {
        role: 'system',
        content: `Call Transcript:\n${transcript}`
      },
      {
        role: 'user',
        content: `
Analyze this call and return:
1. Call summary
2. Patient concerns
3. Nurse statements that may be inappropriate or unsafe
4. Why each statement is problematic
5. Safer alternatives the nurse should have used
`
      }
    ];

    const aiMessage = await callOpenAI(messages);

if (!aiMessage) {
  throw new Error('Backend returned no AI content');
}


    setChatMessages(prev => [
      ...prev,
      { role: 'assistant', content: aiMessage }
    ]);
  } catch (error) {
    setChatMessages(prev => [
      ...prev,
      {
        role: 'assistant',
        content: `Error: ${error.message}`,
        isError: true
      }
    ]);
  } finally {
    setIsChatLoading(false);
  }
};


  // Send chat message
const sendChatMessage = async () => {
  if (!chatInput.trim() || isChatLoading) return;

  const userMessage = chatInput.trim();
  setChatInput('');
  setChatMessages(prev => [...prev, { role: 'user', content: userMessage }]);
  setIsChatLoading(true);

  try {
    const conversationHistory = [...chatMessages]
  .filter(m => !m.isSystem && !m.isHidden)
  .map(m => ({ role: m.role, content: m.content }));

    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'system',
        content: `Discharge Summary:\n${dischargeSummary || 'Not provided'}`
      },
      {
        role: 'system',
        content: `Call Transcript:\n${callTranscript}`
      },
      ...conversationHistory,
      { role: 'user', content: userMessage }
    ];

    const aiMessage = await callOpenAI(messages);

if (!aiMessage) {
  throw new Error('Backend returned no AI content');
}


    setChatMessages(prev => [
      ...prev,
      { role: 'assistant', content: aiMessage }
    ]);
  } catch (error) {
    setChatMessages(prev => [
      ...prev,
      {
        role: 'assistant',
        content: `Error: ${error.message}`,
        isError: true
      }
    ]);
  } finally {
    setIsChatLoading(false);
  }
};


  // Generate care questions from discharge summary


const generateCareQuestions = async (summaryText) => {
  if (!summaryText) return;

  setIsGeneratingQuestions(true);

  try {
    const messages = [
      {
        role: 'system',
        content: `
You are a healthcare AI assistant.
Generate follow-up questions nurses should ask patients.
Group them by:
- Medications
- Symptoms
- Lifestyle
- Warning signs

Respond in clean bullet points. No JSON.
        `
      },
      {
        role: 'user',
        content: summaryText
      }
    ];

    const aiMessage = await callOpenAI(messages);

    if (!aiMessage) {
      throw new Error('Backend returned no AI content');
    }

    setDischargeChatMessages([
      { role: 'assistant', content: aiMessage }
    ]);
  } catch (err) {
    alert(err.message);
  } finally {
    setIsGeneratingQuestions(false);
  }
};

  const handleKeyPress = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendChatMessage();
    }
  };

  const handleDischargeKeyPress = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendDischargeChatMessage();
    }
  };

  // Send discharge chat message
  const sendDischargeChatMessage = async () => {
    if (!dischargeChatInput.trim() || isDischargeChatLoading) return;

    const userMessage = dischargeChatInput.trim();
    setDischargeChatInput('');
    setDischargeChatMessages(prev => [...prev, { role: 'user', content: userMessage }]);
    setIsDischargeChatLoading(true);

    try {
      const conversationHistory = dischargeChatMessages
        .filter(m => !m.isSystem && !m.isHidden)
        .map(m => ({ role: m.role, content: m.content }));

      const messages = [
  {
    role: 'system',
    content: `
You are a healthcare assistant.
Generate follow-up questions nurses should ask patients.
Group them by:
- Medications
- Symptoms
- Lifestyle
- Warning signs

Respond in clean bullet points. No JSON.
    `,
  },
  {
    role: 'user',
    content: `
Discharge Summary:
${dischargeSummary}

User Question:
${userMessage}
`
,
  },
];


      const aiMessage = await callOpenAI(messages);

      if (!aiMessage) {
        throw new Error('Backend returned no AI content');
      }

      setDischargeChatMessages(prev => [
        ...prev,
        { role: 'assistant', content: aiMessage }
      ]);
    } catch (error) {
      setDischargeChatMessages(prev => [
        ...prev,
        { role: 'assistant', content: `Error: ${error.message}`, isError: true }
      ]);
    } finally {
      setIsDischargeChatLoading(false);
    }
  };

  // Voice Assistant Functions
  const startRecording = async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

    audioChunksRef.current = [];

    const mediaRecorder = new MediaRecorder(stream, {
      mimeType: 'audio/webm;codecs=opus',
    });

    mediaRecorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        audioChunksRef.current.push(event.data);
      }
    };

    mediaRecorderRef.current = mediaRecorder;
    mediaRecorder.start();

    setIsRecording(true);
    setVoiceStatus('recording');
  } catch (error) {
    alert('Could not access microphone: ' + error.message);
  }
};


const stopRecording = () => {
  if (!mediaRecorderRef.current) return;

  mediaRecorderRef.current.stop();
  setIsRecording(false);
  setVoiceStatus('processing');

  mediaRecorderRef.current.onstop = async () => {
    const audioBlob = new Blob(audioChunksRef.current, {
      type: 'audio/webm',
    });

    audioChunksRef.current = [];

    setVoiceMessages(prev => [
      ...prev,
      { role: 'user', content: '🎤 Voice message sent...', isVoice: true },
    ]);

    await sendAudioToBackend(audioBlob);

    mediaRecorderRef.current.stream
      .getTracks()
      .forEach(track => track.stop());
  };
};


  const sendAudioToBackend = async (audioBlob) => {
    setIsProcessingVoice(true);
    
    try {
      const formData = new FormData();
      formData.append('audio', audioBlob, 'recording.webm');
      formData.append('dischargeSummary', dischargeSummary || '');
      formData.append('preferredLanguage', preferredLanguage);

      
      const res = await fetch('http://localhost:3001/api/voice', {
        method: 'POST',
        body: formData
      });
      
      if (!res.ok) {
  throw new Error(`Voice API failed (${res.status})`);
}
const data = await res.json();


      if (data.alert) {
      setVoiceMessages(prev => [
      ...prev,
    {
      role: 'assistant',
      content: '🚨 Nurse has been alerted. A human will contact the patient shortly.',
      isAlert: true
    }
  ]);
}

      if (data.error) {
        throw new Error(data.error);
      }
      
      setVoiceMessages(prev => [
  ...prev.slice(0, -1),
  { role: 'user', content: `🎤 "${data.transcription || 'Voice message'}"` }
]);

      
      setVoiceMessages(prev => [...prev, { 
        role: 'assistant', 
        content: data.responseText || 'Response received',
        isVoice: true 
      }]);
      
      if (data.audioBase64) {
        setVoiceStatus('playing');
        playAudioResponse(data.audioBase64);
      } else {
        setVoiceStatus('idle');
      }
      
    } catch (error) {
      setVoiceMessages(prev => [...prev, { 
        role: 'assistant', 
        content: `Error: ${error.message}`, 
        isError: true 
      }]);
      setVoiceStatus('idle');
    } finally {
      setIsProcessingVoice(false);
    }
  };

  const playAudioResponse = (base64) => {
    const audio = new Audio(`data:audio/mp3;base64,${base64}`);
    audio.onended = () => setVoiceStatus('idle');
    audio.onerror = () => setVoiceStatus('idle');
    audio.play();
  };

  return (
    <div style={styles.container}>
      {/* Sidebar */}
      <aside style={styles.sidebar}>
        <div style={styles.logoContainer}>
          <div style={styles.logoIcon}>
  <img
    src={CarelyLogoIcon}
    alt="Carely"
    style={{
      width: '36px',
      height: '36px',
      objectFit: 'contain'
    }}
  />
</div>

        </div>
        <nav style={styles.nav}>
          <button 
            style={{...styles.navButton, ...(activeTab === 'call-logs' ? styles.navButtonActive : {})}}
            onClick={() => setActiveTab('call-logs')}
            title="Call Analysis"
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>
            </svg>
          </button>
          <button 
            style={{...styles.navButton, ...(activeTab === 'discharge' ? styles.navButtonActive : {})}}
            onClick={() => setActiveTab('discharge')}
            title="Care Questions"
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
              <polyline points="14 2 14 8 20 8"/>
              <line x1="16" y1="13" x2="8" y2="13"/>
              <line x1="16" y1="17" x2="8" y2="17"/>
              <polyline points="10 9 9 9 8 9"/>
            </svg>
          </button>
          <button 
            style={{...styles.navButton, ...(activeTab === 'voice' ? styles.navButtonActive : {})}}
            onClick={() => setActiveTab('voice')}
            title="Voice Assistant"
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
              <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
              <line x1="12" y1="19" x2="12" y2="23"/>
              <line x1="8" y1="23" x2="16" y2="23"/>
            </svg>
          </button>
        </nav>
      </aside>

      {/* Main Content */}
      <main style={styles.main}>
        {/* Header */}
        <header style={styles.header}>
          <div style={styles.headerLeft}>
            <img
  src={CarelyLogoFull}
  alt="Carely"
  style={{
    height: '36px',
    objectFit: 'contain'
  }}
/>

            <span style={styles.headerBadge}>AI Assistant</span>
          </div>
          <div style={styles.headerRight}>
            <span style={styles.welcomeText}>Healthcare Intelligence Platform</span>
          </div>
        </header>

        {/* Content Area */}
        <div style={styles.content}>
          {activeTab === 'call-logs' && (
            <div style={styles.splitViewWide}>
              {/* Left Panel - File Upload (Smaller) */}
              <div style={styles.panelSmall}>
                <div style={styles.panelHeader}>
                  <h3 style={styles.panelTitle}>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#0891b2" strokeWidth="2" style={{marginRight: '8px'}}>
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                      <polyline points="17 8 12 3 7 8"/>
                      <line x1="12" y1="3" x2="12" y2="15"/>
                    </svg>
                    Upload Files
                  </h3>
                </div>
                
                <div style={styles.uploadContainerCompact}>
                  <input
                    type="file"
                    ref={callFileInputRef}
                    onChange={handleCallFileUpload}
                    accept=".txt"
                    style={{ display: 'none' }}
                  />
                  
                  <p style={styles.uploadLabel}>Call Transcript</p>
                  {!callFile ? (
                    <div 
                      style={styles.dropZoneCompact}
                      onClick={() => callFileInputRef.current?.click()}
                    >
                      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#0891b2" strokeWidth="1.5">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                        <polyline points="17 8 12 3 7 8"/>
                        <line x1="12" y1="3" x2="12" y2="15"/>
                      </svg>
                      <span style={styles.dropZoneTextCompact}>Upload .txt</span>
                    </div>
                  ) : (
                    <div style={styles.fileUploadedCompact}>
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#10b981" strokeWidth="2">
                        <polyline points="9 11 12 14 22 4"/>
                        <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>
                      </svg>
                      <span style={styles.fileNameCompact}>{callFile.name}</span>
                      <button 
                        style={styles.removeFileButtonCompact}
                        onClick={() => {
                          setCallFile(null);
                          setCallTranscript('');
                          setChatMessages([]);
                        }}
                      >✕</button>
                    </div>
                  )}

                  <p style={{...styles.uploadLabel, marginTop: '16px'}}>Discharge Summary</p>
                  {!dischargeFile ? (
                    <div 
                      style={styles.dropZoneCompact}
                      onClick={() => dischargeFileInputRef.current?.click()}
                    >
                      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#f97316" strokeWidth="1.5">
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                        <polyline points="14 2 14 8 20 8"/>
                      </svg>
                      <span style={styles.dropZoneTextCompact}>Upload .txt/.pdf</span>
                    </div>
                  ) : (
                    <div style={styles.fileUploadedCompact}>
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#10b981" strokeWidth="2">
                        <polyline points="9 11 12 14 22 4"/>
                        <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>
                      </svg>
                      <span style={styles.fileNameCompact}>{dischargeFile.name}</span>
                      <button 
                        style={styles.removeFileButtonCompact}
                        onClick={() => {
                          setDischargeFile(null);
                          setDischargeSummary('');
                        }}
                      >✕</button>
                    </div>
                  )}
                  
                  <input
                    type="file"
                    ref={dischargeFileInputRef}
                    onChange={handleDischargeFileUpload}
                    accept=".pdf,.txt"
                    style={{ display: 'none' }}
                  />
                </div>

                {callTranscript && (
                  <div style={styles.transcriptPreviewCompact}>
                    <h4 style={styles.previewTitleCompact}>Preview</h4>
                    <div style={styles.previewContentCompact}>
                      {callTranscript.substring(0, 300)}
                      {callTranscript.length > 300 && '...'}
                    </div>
                  </div>
                )}
              </div>

              {/* Right Panel - Chat Interface (Larger) */}
              <div style={styles.panelLarge}>
                <div style={styles.panelHeader}>
                  <h3 style={styles.panelTitle}>
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#f97316" strokeWidth="2" style={{marginRight: '8px'}}>
                      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                    </svg>
                    AI Call Analysis Chat
                  </h3>
                </div>
                
                <div style={styles.chatContainer}>
                  <div style={styles.chatMessages}>
                    {chatMessages.length === 0 ? (
                      <div style={styles.chatEmpty}>
                        <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="#cbd5e1" strokeWidth="1.5">
                          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                        </svg>
                        <p>Upload a call log to start the AI analysis</p>
                      </div>
                    ) : (
                      chatMessages.map((msg, idx) => (
                        !msg.isHidden && (
                          <div 
                            key={idx} 
                            style={{
                              ...styles.chatMessage,
                              ...(msg.isSystem ? styles.systemMessage : 
                                  msg.role === 'user' ? styles.userMessage : styles.assistantMessage),
                              ...(msg.isError ? styles.errorMessage : {})
                            }}
                          >
                            {!msg.isSystem && (
                              <div style={styles.messageAvatar}>
                                {msg.role === 'user' ? '👤' : '🤖'}
                              </div>
                            )}
                            <div style={styles.messageContent}>
                              {renderTextWithBold(msg.content)}
                            </div>
                          </div>
                        )
                      ))
                    )}
                    {isChatLoading && (
                      <div style={{...styles.chatMessage, ...styles.assistantMessage}}>
                        <div style={styles.messageAvatar}>🤖</div>
                        <div style={styles.typingIndicator}>
                          <span></span><span></span><span></span>
                        </div>
                      </div>
                    )}
                    <div ref={chatEndRef} />
                  </div>
                  
                  <div style={styles.chatInputContainer}>
                    <input
                      type="text"
                      value={chatInput}
                      onChange={(e) => setChatInput(e.target.value)}
                      onKeyPress={handleKeyPress}
                      placeholder={callFile ? "Ask about the call..." : "Upload a call log first..."}
                      disabled={!callFile || isChatLoading}
                      style={styles.chatInput}
                    />
                    <button 
                      onClick={sendChatMessage}
                      disabled={!callFile || !chatInput.trim() || isChatLoading}
                      style={{
                        ...styles.sendButton,
                        opacity: (!callFile || !chatInput.trim() || isChatLoading) ? 0.5 : 1
                      }}
                    >
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <line x1="22" y1="2" x2="11" y2="13"/>
                        <polygon points="22 2 15 22 11 13 2 9 22 2"/>
                      </svg>
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'discharge' && (
            <div style={styles.splitViewWide}>
              {/* Left Panel - File Upload (Smaller) */}
              <div style={styles.panelSmall}>
                <div style={styles.panelHeader}>
                  <h3 style={styles.panelTitle}>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#0891b2" strokeWidth="2" style={{marginRight: '8px'}}>
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                      <polyline points="14 2 14 8 20 8"/>
                    </svg>
                    Discharge Summary
                  </h3>
                </div>
                
                <div style={styles.uploadContainerCompact}>
                  <input
                    type="file"
                    ref={dischargeFileInputRef}
                    onChange={handleDischargeFileUpload}
                    accept=".pdf,.txt"
                    style={{ display: 'none' }}
                  />
                  
                  {!dischargeFile ? (
                    <div 
                      style={{...styles.dropZoneCompact, minHeight: '100px'}}
                      onClick={() => dischargeFileInputRef.current?.click()}
                    >
                      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#f97316" strokeWidth="1.5">
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                        <polyline points="14 2 14 8 20 8"/>
                        <line x1="12" y1="18" x2="12" y2="12"/>
                        <line x1="9" y1="15" x2="12" y2="12"/>
                        <line x1="15" y1="15" x2="12" y2="12"/>
                      </svg>
                      <span style={styles.dropZoneTextCompact}>Click to upload</span>
                      <span style={{fontSize: '11px', color: '#94a3b8'}}>PDF or TXT</span>
                    </div>
                  ) : (
                    <div style={styles.fileUploadedCompact}>
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#10b981" strokeWidth="2">
                        <polyline points="9 11 12 14 22 4"/>
                        <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>
                      </svg>
                      <span style={styles.fileNameCompact}>{dischargeFile.name}</span>
                      <button 
                        style={styles.removeFileButtonCompact}
                        onClick={() => {
                          setDischargeFile(null);
                          setDischargeSummary('');
                          setDischargeChatMessages([]);
                        }}
                      >✕</button>
                    </div>
                  )}
                </div>

                {dischargeSummary && (
                  <div style={styles.transcriptPreviewCompact}>
                    <h4 style={styles.previewTitleCompact}>Summary Preview</h4>
                    <div style={{...styles.previewContentCompact, maxHeight: '400px'}}>
                      {dischargeSummary.substring(0, 600)}
                      {dischargeSummary.length > 600 && '...'}
                    </div>
                  </div>
                )}
              </div>

              {/* Right Panel - Chat Interface for Questions */}
              <div style={styles.panelLarge}>
                <div style={styles.panelHeader}>
                  <h3 style={styles.panelTitle}>
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#f97316" strokeWidth="2" style={{marginRight: '8px'}}>
                      <circle cx="12" cy="12" r="10"/>
                      <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/>
                      <line x1="12" y1="17" x2="12.01" y2="17"/>
                    </svg>
                    Care Questions Chat
                  </h3>
                </div>
                
                <div style={styles.chatContainer}>
                  <div style={styles.chatMessages}>
                    {dischargeChatMessages.length === 0 ? (
                      <div style={styles.chatEmpty}>
                        <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="#cbd5e1" strokeWidth="1.5">
                          <circle cx="12" cy="12" r="10"/>
                          <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/>
                          <line x1="12" y1="17" x2="12.01" y2="17"/>
                        </svg>
                        <p>Upload a discharge summary to generate care questions</p>
                      </div>
                    ) : (
                      dischargeChatMessages.map((msg, idx) => (
                        !msg.isHidden && (
                          <div 
                            key={idx} 
                            style={{
                              ...styles.chatMessage,
                              ...(msg.isSystem ? styles.systemMessage : 
                                  msg.role === 'user' ? styles.userMessage : styles.assistantMessage),
                              ...(msg.isError ? styles.errorMessage : {})
                            }}
                          >
                            {!msg.isSystem && (
                              <div style={styles.messageAvatar}>
                                {msg.role === 'user' ? '👤' : '🤖'}
                              </div>
                            )}
                            <div style={styles.messageContent}>
                              {renderTextWithBold(msg.content)}
                            </div>
                          </div>
                        )
                      ))
                    )}
                    {isDischargeChatLoading && (
                      <div style={{...styles.chatMessage, ...styles.assistantMessage}}>
                        <div style={styles.messageAvatar}>🤖</div>
                        <div style={styles.typingIndicator}>
                          <span></span><span></span><span></span>
                        </div>
                      </div>
                    )}
                    <div ref={dischargeChatEndRef} />
                  </div>
                  
                  <div style={styles.chatInputContainer}>
                    <input
                      type="text"
                      value={dischargeChatInput}
                      onChange={(e) => setDischargeChatInput(e.target.value)}
                      onKeyPress={handleDischargeKeyPress}
                      placeholder={dischargeFile ? "Ask about care questions..." : "Upload a discharge summary first..."}
                      disabled={!dischargeFile || isDischargeChatLoading}
                      style={styles.chatInput}
                    />
                    <button 
                      onClick={sendDischargeChatMessage}
                      disabled={!dischargeFile || !dischargeChatInput.trim() || isDischargeChatLoading}
                      style={{
                        ...styles.sendButton,
                        background: 'linear-gradient(135deg, #f97316, #ea580c)',
                        opacity: (!dischargeFile || !dischargeChatInput.trim() || isDischargeChatLoading) ? 0.5 : 1
                      }}
                    >
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <line x1="22" y1="2" x2="11" y2="13"/>
                        <polygon points="22 2 15 22 11 13 2 9 22 2"/>
                      </svg>
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Voice Assistant Tab */}
          {activeTab === 'voice' && (
            <div style={styles.splitViewWide}>
              {/* Left Panel - Discharge Summary Upload */}
              <div style={styles.panelSmall}>
                <div style={styles.panelHeader}>
                  <h3 style={styles.panelTitle}>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#8b5cf6" strokeWidth="2" style={{marginRight: '8px'}}>
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                      <polyline points="14 2 14 8 20 8"/>
                    </svg>
                    Discharge Summary
                  </h3>
                </div>
                
                <div style={styles.uploadContainerCompact}>
                  <input
                    type="file"
                    ref={dischargeFileInputRef}
                    onChange={handleDischargeFileUpload}
                    accept=".pdf,.txt"
                    style={{ display: 'none' }}
                  />
                  
                  {!dischargeFile ? (
                    <div 
                      style={{...styles.dropZoneCompact, minHeight: '100px'}}
                      onClick={() => dischargeFileInputRef.current?.click()}
                    >
                      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#8b5cf6" strokeWidth="1.5">
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                        <polyline points="14 2 14 8 20 8"/>
                        <line x1="12" y1="18" x2="12" y2="12"/>
                        <line x1="9" y1="15" x2="12" y2="12"/>
                        <line x1="15" y1="15" x2="12" y2="12"/>
                      </svg>
                      <span style={styles.dropZoneTextCompact}>Upload discharge summary</span>
                      <span style={{fontSize: '11px', color: '#94a3b8'}}>For context during voice calls</span>
                    </div>
                  ) : (
                    <div style={styles.fileUploadedCompact}>
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#10b981" strokeWidth="2">
                        <polyline points="9 11 12 14 22 4"/>
                        <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>
                      </svg>
                      <span style={styles.fileNameCompact}>{dischargeFile.name}</span>
                      <button 
                        style={styles.removeFileButtonCompact}
                        onClick={() => {
                          setDischargeFile(null);
                          setDischargeSummary('');
                        }}
                      >✕</button>
                    </div>
                  )}
                </div>

                {dischargeSummary && (
                  <div style={styles.transcriptPreviewCompact}>
                    <h4 style={styles.previewTitleCompact}>Summary Preview</h4>
                    <div style={{...styles.previewContentCompact, maxHeight: '400px'}}>
                      {dischargeSummary.substring(0, 600)}
                      {dischargeSummary.length > 600 && '...'}
                    </div>
                  </div>
                )}

                <div style={{padding: '16px', borderTop: '1px solid #e2e8f0', marginTop: 'auto'}}>
                  <p style={{fontSize: '12px', color: '#64748b', lineHeight: '1.5'}}>
                    💡 <strong>Tip:</strong> Upload the patient's discharge summary so the AI can ask relevant follow-up questions during the voice call.
                  </p>
                </div>
              </div>

              {/* Right Panel - Voice Interface */}
              <div style={styles.panelLarge}>
                <div style={styles.panelHeader}>
                  <h3 style={styles.panelTitle}>
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#8b5cf6" strokeWidth="2" style={{marginRight: '8px'}}>
                      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
                      <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
                      <line x1="12" y1="19" x2="12" y2="23"/>
                      <line x1="8" y1="23" x2="16" y2="23"/>
                    </svg>
                    Voice Call Assistant
                    {dischargeSummary && <span style={{marginLeft: '8px', fontSize: '11px', color: '#10b981'}}>● Context loaded</span>}
                  </h3>
                </div>

                <div style={styles.voiceChatArea}>
                  <div style={styles.chatMessages}>
                    {voiceMessages.length === 0 ? (
                      <div style={styles.chatEmpty}>
                        <svg width="80" height="80" viewBox="0 0 24 24" fill="none" stroke="#cbd5e1" strokeWidth="1">
                          <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
                          <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
                          <line x1="12" y1="19" x2="12" y2="23"/>
                          <line x1="8" y1="23" x2="16" y2="23"/>
                        </svg>
                        <p style={{marginTop: '16px', fontSize: '16px'}}>Press the microphone to start talking</p>
                        <p style={{fontSize: '13px', color: '#94a3b8', marginTop: '8px'}}>
                          {dischargeSummary 
                            ? 'Discharge summary loaded - AI will use it for context' 
                            : 'Upload a discharge summary for better context'}
                        </p>
                      </div>
                    ) : (
                      voiceMessages.map((msg, idx) => (
                        <div 
                          key={idx} 
                          style={{
                            ...styles.chatMessage,
                            ...(msg.role === 'user' ? styles.userMessage : styles.assistantMessage),
                            ...(msg.isError ? styles.errorMessage : {})
                          }}
                        >
                          <div style={styles.messageAvatar}>
                            {msg.role === 'user' ? '🎤' : '🤖'}
                          </div>
                          <div style={styles.messageContent}>
                            {renderTextWithBold(msg.content)}
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>

                <div style={styles.voiceControls}>
                  <div style={styles.voiceStatusText}>
                    {voiceStatus === 'idle' && 'Ready to listen'}
                    {voiceStatus === 'recording' && '🔴 Recording...'}
                    {voiceStatus === 'processing' && '⏳ Processing...'}
                    {voiceStatus === 'playing' && '🔊 Playing response...'}
                  </div>
                  
                  <button
                    style={{
                      ...styles.voiceButton,
                      ...(isRecording ? styles.voiceButtonRecording : {}),
                      ...(isProcessingVoice ? styles.voiceButtonProcessing : {})
                    }}
                    onMouseDown={startRecording}
                    onMouseUp={stopRecording}
                    onMouseLeave={() => isRecording && stopRecording()}
                    onTouchStart={startRecording}
                    onTouchEnd={stopRecording}
                    disabled={isProcessingVoice || voiceStatus === 'playing'}
                  >
                    {isProcessingVoice ? (
                      <div style={styles.spinnerLarge}></div>
                    ) : (
                      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
                        <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
                        <line x1="12" y1="19" x2="12" y2="23"/>
                        <line x1="8" y1="23" x2="16" y2="23"/>
                      </svg>
                    )}
                  </button>
                  
                  <p style={styles.voiceHint}>
                    {isRecording ? 'Release to send' : 'Hold to talk'}
                  </p>
                </div>
              </div>
            </div>
          )}
        </div>
      </main>

      <style>{`
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(10px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes bounce {
          0%, 60%, 100% { transform: translateY(0); }
          30% { transform: translateY(-4px); }
        }
        @keyframes pulse {
          0%, 100% { transform: scale(1); box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.7); }
          50% { transform: scale(1.05); box-shadow: 0 0 0 15px rgba(239, 68, 68, 0); }
        }
      `}</style>
    </div>
  );
};

// Question Category Component
const QuestionCategory = ({ title, questions, color }) => (
  <div style={{
    marginBottom: '20px',
    padding: '16px',
    background: '#fff',
    borderRadius: '12px',
    border: `2px solid ${color}20`,
    animation: 'fadeIn 0.3s ease-out'
  }}>
    <h4 style={{
      margin: '0 0 12px 0',
      color: color,
      fontSize: '14px',
      fontWeight: '600',
      letterSpacing: '0.5px'
    }}>{title}</h4>
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      {questions.map((q, i) => (
        <div key={i} style={{
          padding: '12px',
          background: `${color}08`,
          borderRadius: '8px',
          borderLeft: `3px solid ${color}`
        }}>
          <p style={{ margin: '0 0 6px 0', fontWeight: '500', color: '#1e293b', fontSize: '14px' }}>
            {q.question || q}
          </p>
          {q.importance && (
            <p style={{ margin: 0, fontSize: '12px', color: '#64748b', fontStyle: 'italic' }}>
              Why: {q.importance}
            </p>
          )}
        </div>
      ))}
    </div>
  </div>
);

// Styles
const styles = {
  container: {
    display: 'flex',
    minHeight: '100vh',
    background: 'linear-gradient(135deg, #f8fafc 0%, #e2e8f0 100%)',
    fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif"
  },
  
  // Sidebar
  sidebar: {
    width: '64px',
    background: 'linear-gradient(180deg, #0f172a 0%, #1e293b 100%)',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    padding: '16px 0',
    boxShadow: '4px 0 20px rgba(0,0,0,0.1)'
  },
  logoContainer: {
    marginBottom: '32px'
  },
  logoIcon: {
    width: '40px',
    height: '40px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center'
  },
  nav: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    flex: 1
  },
  navButton: {
    width: '48px',
    height: '48px',
    border: 'none',
    borderRadius: '12px',
    background: 'transparent',
    color: '#94a3b8',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    transition: 'all 0.2s ease'
  },
  navButtonActive: {
    background: 'linear-gradient(135deg, #0891b2, #0e7490)',
    color: '#fff',
    boxShadow: '0 4px 12px rgba(8, 145, 178, 0.4)'
  },

  // Main
  main: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden'
  },
  
  // Header
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '16px 32px',
    background: '#fff',
    borderBottom: '1px solid #e2e8f0',
    boxShadow: '0 2px 10px rgba(0,0,0,0.05)'
  },
  headerLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px'
  },
  logo: {
    margin: 0,
    fontSize: '28px',
    fontWeight: '700',
    letterSpacing: '-0.5px'
  },
  logoText: {
    color: '#0891b2'
  },
  logoAccent: {
    color: '#f97316'
  },
  headerBadge: {
    padding: '4px 12px',
    background: 'linear-gradient(135deg, #0891b2, #0e7490)',
    color: '#fff',
    borderRadius: '20px',
    fontSize: '12px',
    fontWeight: '600',
    letterSpacing: '0.5px'
  },
  headerRight: {
    display: 'flex',
    alignItems: 'center'
  },
  welcomeText: {
    color: '#64748b',
    fontSize: '14px',
    fontWeight: '500'
  },

  // Content
  content: {
    flex: 1,
    padding: '24px 32px 32px',
    overflow: 'auto'
  },
  splitView: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: '24px',
    height: 'calc(100vh - 140px)'
  },
  
  // New: Wide split view (smaller left, bigger right)
  splitViewWide: {
    display: 'grid',
    gridTemplateColumns: '280px 1fr',
    gap: '20px',
    height: 'calc(100vh - 100px)'
  },
  
  // Panel
  panel: {
    background: '#fff',
    borderRadius: '16px',
    boxShadow: '0 4px 20px rgba(0,0,0,0.08)',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden'
  },
  panelSmall: {
    background: '#fff',
    borderRadius: '16px',
    boxShadow: '0 4px 20px rgba(0,0,0,0.08)',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden'
  },
  panelLarge: {
    background: '#fff',
    borderRadius: '16px',
    boxShadow: '0 4px 20px rgba(0,0,0,0.08)',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden'
  },
  panelHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '20px 24px',
    borderBottom: '1px solid #e2e8f0',
    background: 'linear-gradient(135deg, #f8fafc, #fff)'
  },
  panelTitle: {
    margin: 0,
    fontSize: '16px',
    fontWeight: '600',
    color: '#1e293b',
    display: 'flex',
    alignItems: 'center'
  },

  // Upload Area
  uploadContainer: {
    padding: '24px',
    flex: dischargeFile => dischargeFile ? '0 0 auto' : 1,
    display: 'flex',
    flexDirection: 'column'
  },
  dropZone: {
    flex: 1,
    minHeight: '200px',
    border: '2px dashed #cbd5e1',
    borderRadius: '12px',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    transition: 'all 0.2s ease',
    background: '#f8fafc'
  },
  dropZoneIcon: {
    marginBottom: '16px',
    opacity: 0.8
  },
  dropZoneText: {
    margin: '0 0 8px 0',
    fontSize: '16px',
    fontWeight: '500',
    color: '#334155'
  },
  dropZoneSubtext: {
    margin: 0,
    fontSize: '13px',
    color: '#94a3b8'
  },
  fileUploaded: {
    display: 'flex',
    alignItems: 'center',
    padding: '16px 20px',
    background: '#f0fdf4',
    borderRadius: '12px',
    border: '2px solid #86efac'
  },
  fileIcon: {
    marginRight: '16px'
  },
  fileInfo: {
    flex: 1
  },
  fileName: {
    margin: '0 0 4px 0',
    fontSize: '14px',
    fontWeight: '600',
    color: '#166534'
  },
  fileSize: {
    margin: 0,
    fontSize: '12px',
    color: '#15803d'
  },
  removeFileButton: {
    width: '36px',
    height: '36px',
    border: 'none',
    borderRadius: '8px',
    background: '#fee2e2',
    color: '#dc2626',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center'
  },

  // Transcript Preview
  transcriptPreview: {
    flex: 1,
    padding: '0 24px 24px',
    overflow: 'auto'
  },
  previewTitle: {
    margin: '0 0 12px 0',
    fontSize: '13px',
    fontWeight: '600',
    color: '#64748b',
    textTransform: 'uppercase',
    letterSpacing: '0.5px'
  },
  previewContent: {
    padding: '16px',
    background: '#f8fafc',
    borderRadius: '8px',
    fontSize: '13px',
    lineHeight: '1.6',
    color: '#475569',
    whiteSpace: 'pre-wrap',
    maxHeight: '300px',
    overflow: 'auto'
  },

  // Chat Interface
  chatContainer: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden'
  },
  chatMessages: {
    flex: 1,
    padding: '24px',
    overflow: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: '16px'
  },
  chatEmpty: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    color: '#94a3b8',
    textAlign: 'center'
  },
  chatMessage: {
    display: 'flex',
    gap: '12px',
    animation: 'fadeIn 0.3s ease-out'
  },
  systemMessage: {
    justifyContent: 'center',
    padding: '8px 16px',
    background: '#f1f5f9',
    borderRadius: '8px',
    fontSize: '13px',
    color: '#64748b'
  },
  userMessage: {
    flexDirection: 'row-reverse'
  },
  assistantMessage: {
    flexDirection: 'row'
  },
  errorMessage: {
    opacity: 0.8
  },
  messageAvatar: {
    width: '36px',
    height: '36px',
    borderRadius: '10px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '18px',
    background: '#f1f5f9',
    flexShrink: 0
  },
  messageContent: {
    maxWidth: '80%',
    padding: '12px 16px',
    borderRadius: '12px',
    fontSize: '14px',
    lineHeight: '1.6',
    background: '#f1f5f9',
    color: '#1e293b',
    whiteSpace: 'pre-wrap'
  },
  typingIndicator: {
    display: 'flex',
    gap: '4px',
    padding: '16px',
    background: '#f1f5f9',
    borderRadius: '12px'
  },
  chatInputContainer: {
    padding: '16px 24px 24px',
    display: 'flex',
    gap: '12px',
    borderTop: '1px solid #e2e8f0'
  },
  chatInput: {
    flex: 1,
    padding: '14px 18px',
    border: '2px solid #e2e8f0',
    borderRadius: '12px',
    fontSize: '14px',
    outline: 'none',
    transition: 'border-color 0.2s ease'
  },
  sendButton: {
    width: '48px',
    height: '48px',
    border: 'none',
    borderRadius: '12px',
    background: 'linear-gradient(135deg, #0891b2, #0e7490)',
    color: '#fff',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    transition: 'all 0.2s ease'
  },

  // Generate Button
  generateButton: {
    margin: '0 24px 24px',
    padding: '14px 24px',
    background: 'linear-gradient(135deg, #f97316, #ea580c)',
    border: 'none',
    borderRadius: '12px',
    color: '#fff',
    fontSize: '15px',
    fontWeight: '600',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    transition: 'all 0.2s ease',
    boxShadow: '0 4px 12px rgba(249, 115, 22, 0.3)'
  },
  spinner: {
    width: '18px',
    height: '18px',
    border: '2px solid rgba(255,255,255,0.3)',
    borderTopColor: '#fff',
    borderRadius: '50%',
    marginRight: '10px',
    animation: 'spin 0.8s linear infinite'
  },

  // Questions Container
  questionsContainer: {
    flex: 1,
    padding: '24px',
    overflow: 'auto'
  },
  questionsResults: {
    display: 'flex',
    flexDirection: 'column'
  },
  emptyState: {
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    color: '#94a3b8'
  },
  emptyText: {
    marginTop: '16px',
    textAlign: 'center',
    fontSize: '14px',
    maxWidth: '250px',
    lineHeight: '1.5'
  },
  rawText: {
    whiteSpace: 'pre-wrap',
    fontSize: '14px',
    lineHeight: '1.6',
    color: '#334155'
  },

  // Compact Upload Styles
  uploadContainerCompact: {
    padding: '16px',
    display: 'flex',
    flexDirection: 'column',
    gap: '8px'
  },
  uploadLabel: {
    fontSize: '12px',
    fontWeight: '600',
    color: '#64748b',
    textTransform: 'uppercase',
    letterSpacing: '0.5px',
    marginBottom: '4px'
  },
  dropZoneCompact: {
    padding: '16px',
    border: '2px dashed #cbd5e1',
    borderRadius: '10px',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    transition: 'all 0.2s ease',
    background: '#f8fafc',
    gap: '8px'
  },
  dropZoneTextCompact: {
    fontSize: '13px',
    fontWeight: '500',
    color: '#64748b'
  },
  fileUploadedCompact: {
    display: 'flex',
    alignItems: 'center',
    padding: '10px 12px',
    background: '#f0fdf4',
    borderRadius: '8px',
    border: '1px solid #86efac',
    gap: '8px'
  },
  fileNameCompact: {
    flex: 1,
    fontSize: '12px',
    fontWeight: '500',
    color: '#166534',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap'
  },
  removeFileButtonCompact: {
    width: '24px',
    height: '24px',
    border: 'none',
    borderRadius: '6px',
    background: '#fee2e2',
    color: '#dc2626',
    cursor: 'pointer',
    fontSize: '12px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center'
  },
  transcriptPreviewCompact: {
    flex: 1,
    padding: '0 16px 16px',
    overflow: 'auto'
  },
  previewTitleCompact: {
    margin: '0 0 8px 0',
    fontSize: '11px',
    fontWeight: '600',
    color: '#64748b',
    textTransform: 'uppercase',
    letterSpacing: '0.5px'
  },
  previewContentCompact: {
    padding: '12px',
    background: '#f8fafc',
    borderRadius: '8px',
    fontSize: '11px',
    lineHeight: '1.5',
    color: '#475569',
    whiteSpace: 'pre-wrap',
    maxHeight: '200px',
    overflow: 'auto'
  },

  // Voice Assistant Styles
  voiceContainer: {
    height: 'calc(100vh - 100px)',
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'stretch'
  },
  voicePanel: {
    width: '100%',
    maxWidth: '800px',
    background: '#fff',
    borderRadius: '16px',
    boxShadow: '0 4px 20px rgba(0,0,0,0.08)',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden'
  },
  voiceChatArea: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden'
  },
  voiceControls: {
    padding: '24px',
    borderTop: '1px solid #e2e8f0',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '16px',
    background: 'linear-gradient(135deg, #f8fafc, #fff)'
  },
  voiceStatusText: {
    fontSize: '14px',
    fontWeight: '500',
    color: '#64748b'
  },
  voiceButton: {
    width: '80px',
    height: '80px',
    borderRadius: '50%',
    border: 'none',
    background: 'linear-gradient(135deg, #8b5cf6, #7c3aed)',
    color: '#fff',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    transition: 'all 0.2s ease',
    boxShadow: '0 4px 20px rgba(139, 92, 246, 0.4)'
  },
  voiceButtonRecording: {
    background: 'linear-gradient(135deg, #ef4444, #dc2626)',
    animation: 'pulse 1.5s infinite',
    boxShadow: '0 4px 20px rgba(239, 68, 68, 0.5)'
  },
  voiceButtonProcessing: {
    background: 'linear-gradient(135deg, #f59e0b, #d97706)',
    boxShadow: '0 4px 20px rgba(245, 158, 11, 0.4)'
  },
  voiceHint: {
    fontSize: '13px',
    color: '#94a3b8'
  },
  spinnerLarge: {
    width: '28px',
    height: '28px',
    border: '3px solid rgba(255,255,255,0.3)',
    borderTopColor: '#fff',
    borderRadius: '50%',
    animation: 'spin 0.8s linear infinite'
  }
};

export default CarelyAIAssistant;

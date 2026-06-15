import { useState, useEffect, useRef } from 'react';
import { 
  Send, 
  MessageSquare, 
  Users, 
  CheckCircle2, 
  AlertCircle, 
  Calendar, 
  Smartphone, 
  Sparkles, 
  RefreshCw, 
  Play,
  BarChart3,
  MailCheck,
  Eye,
  XCircle,
  Activity
} from 'lucide-react';

const API_BASE = import.meta.env.VITE_CRM_API_URL || import.meta.env.VITE_API_BASE || 'http://localhost:3001';

// Animated counter component for premium stat-rolling micro-interaction
function AnimatedCounter({ value }) {
  const [displayValue, setDisplayValue] = useState(value || 0);
  const prevValueRef = useRef(value || 0);

  useEffect(() => {
    let start = null;
    const from = prevValueRef.current;
    const to = value || 0;
    if (from === to) return;

    const duration = 600; // 600ms

    const step = (timestamp) => {
      if (!start) start = timestamp;
      const progress = Math.min((timestamp - start) / duration, 1);
      // Easing out quadratic
      const easeProgress = progress * (2 - progress);
      const current = Math.round(easeProgress * (to - from) + from);
      setDisplayValue(current);

      if (progress < 1) {
        requestAnimationFrame(step);
      } else {
        setDisplayValue(to);
        prevValueRef.current = to;
      }
    };

    requestAnimationFrame(step);
  }, [value]);

  return <span>{displayValue}</span>;
}

function App() {
  const [messages, setMessages] = useState([
    {
      role: 'model',
      content: "Hello! I'm your Campaign Copilot marketing analyst. What D2C campaign are we running today? Describe your goal (e.g. 'Re-engage cart abandoners with a 15% discount code')."
    }
  ]);
  const [inputText, setInputText] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  
  // App-wide data
  const [campaigns, setCampaigns] = useState([]);
  const [activeCampaignId, setActiveCampaignId] = useState(null);
  const [liveStats, setLiveStats] = useState(null);
  const [recentEvents, setRecentEvents] = useState([]);
  const [connectionStatus, setConnectionStatus] = useState('checking');
  const [expandedCampaignId, setExpandedCampaignId] = useState(null);
  const [inspectorData, setInspectorData] = useState([]);
  const [isInspectorLoading, setIsInspectorLoading] = useState(false);

  const messagesEndRef = useRef(null);
  const sseRef = useRef(null);

  // Auto-scroll chat to bottom
  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  // Fetch campaigns and verify API health on mount
  useEffect(() => {
    fetchHealth();
    fetchCampaigns();
    return () => disconnectSSE();
  }, []);

  const fetchHealth = async () => {
    try {
      const res = await fetch(`${API_BASE}/health`);
      if (res.ok) {
        setConnectionStatus('online');
      } else {
        setConnectionStatus('error');
      }
    } catch {
      setConnectionStatus('offline');
    }
  };

  const fetchCampaigns = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/campaigns`);
      if (res.ok) {
        const data = await res.json();
        setCampaigns(data);
        
        // Default to the most recent campaign for stats if none selected
        if (data.length > 0 && !activeCampaignId) {
          selectCampaign(data[0].id);
        }
      }
    } catch (err) {
      console.error('Error fetching campaigns:', err);
    }
  };

  // Manage SSE Connection for live ticking dashboard
  const connectSSE = (campaignId) => {
    disconnectSSE();
    
    console.log(`[SSE] Connecting to campaign stream: ${campaignId}`);
    const sse = new EventSource(`${API_BASE}/api/stream/${campaignId}`);
    sseRef.current = sse;

    sse.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        console.log('[SSE Update]:', data);
        if (data.campaign_id === campaignId) {
          setLiveStats(data.stats);
          
          // Set historical events on load
          if (data.events) {
            setRecentEvents(data.events);
          }
          
          // Append new event if present
          if (data.event) {
            setRecentEvents(prev => {
              const updated = [...prev, data.event];
              // Keep the last 10
              return updated.slice(-10);
            });
          }
        }
      } catch (err) {
        console.error('Error parsing SSE data:', err);
      }
    };

    sse.onerror = (err) => {
      console.error('[SSE Error]:', err);
      // EventSource.CLOSED === 2 means the browser gave up reconnecting
      if (sse.readyState === 2) {
        console.log('[SSE] Connection closed permanently, attempting reconnect in 3s...');
        disconnectSSE();
        setTimeout(() => {
          connectSSE(campaignId);
        }, 3000);
      }
      // If readyState is 0 (CONNECTING), the browser is already auto-reconnecting — do nothing
    };
  };

  const disconnectSSE = () => {
    if (sseRef.current) {
      sseRef.current.close();
      sseRef.current = null;
    }
  };

  const selectCampaign = (campaignId) => {
    setActiveCampaignId(campaignId);
    setRecentEvents([]); // Clear logs when switching campaigns
    // Find campaign stats from local state first
    const camp = campaigns.find(c => c.id === campaignId);
    if (camp) {
      setLiveStats(camp.stats);
    }
    // Connect SSE for live ticks
    connectSSE(campaignId);
  };

  const fetchInspectorData = async (campaignId) => {
    setIsInspectorLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/campaigns/${campaignId}/inspector`);
      if (res.ok) {
        const data = await res.json();
        setInspectorData(data);
      } else {
        setInspectorData([]);
      }
    } catch (err) {
      console.error('Error fetching inspector data:', err);
      setInspectorData([]);
    } finally {
      setIsInspectorLoading(false);
    }
  };


  // Custom Markdown parser for conversational formatting, configured for Light Mode
  const renderMarkdown = (text) => {
    if (!text) return null;
    
    // Hide action blocks from render
    const cleanedText = text.replace(/<action>[\s\S]*?<\/action>/g, '').trim();

    return cleanedText.split('\n').map((line, idx) => {
      // List item
      if (line.trim().startsWith('- ') || line.trim().startsWith('* ')) {
        return (
          <li key={idx} className="ml-5 list-disc text-gray-600 my-1.5 text-sm">
            {line.replace(/^[-*]\s+/, '')}
          </li>
        );
      }
      // Bold items
      const boldRegex = /\*\*(.*?)\*\*/g;
      let parts = [];
      let lastIndex = 0;
      let match;
      while ((match = boldRegex.exec(line)) !== null) {
        if (match.index > lastIndex) {
          parts.push(line.substring(lastIndex, match.index));
        }
        parts.push(<strong key={match.index} className="font-semibold text-gray-900">{match[1]}</strong>);
        lastIndex = boldRegex.lastIndex;
      }
      if (lastIndex < line.length) {
        parts.push(line.substring(lastIndex));
      }

      // Headers
      if (line.trim().startsWith('###')) {
        return (
          <h3 key={idx} className="text-xs font-semibold text-gray-500 mt-3 mb-1 uppercase tracking-wider">
            {line.replace(/^###\s+/, '')}
          </h3>
        );
      }
      if (line.trim().startsWith('##')) {
        return (
          <h2 key={idx} className="text-sm font-semibold text-indigo-600 mt-4 mb-1.5">
            {line.replace(/^##\s+/, '')}
          </h2>
        );
      }
      if (line.trim().startsWith('#')) {
        return (
          <h1 key={idx} className="text-base font-semibold text-gray-900 mt-4 mb-2">
            {line.replace(/^#\s+/, '')}
          </h1>
        );
      }
      
      if (!line.trim()) {
        return <div key={idx} className="h-2" />;
      }

      return (
        <p key={idx} className="text-gray-800 text-sm leading-relaxed my-1">
          {parts.length > 0 ? parts : line}
        </p>
      );
    });
  };

  // Submit chat query
  const handleSendMessage = async (textToSend) => {
    const messageContent = textToSend || inputText;
    if (!messageContent.trim()) return;

    if (!textToSend) setInputText('');
    
    // Add user message to UI
    const updatedMessages = [...messages, { role: 'user', content: messageContent }];
    setMessages(updatedMessages);
    setIsLoading(true);

    try {
      const chatHistory = updatedMessages.map(msg => ({
        role: msg.role,
        content: msg.content
      }));

      const response = await fetch(`${API_BASE}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: chatHistory })
      });

      if (!response.ok) throw new Error('API server returned error');

      const data = await response.json();
      
      // Add AI Response to messages
      setMessages(prev => [...prev, {
        role: 'model',
        content: data.text,
        actionResult: data.actionResult
      }]);

      // If campaign was created or updated, refresh campaigns list
      if (data.actionResult && data.actionResult.type === 'CREATE_CAMPAIGN') {
        const campaign = data.actionResult.data;
        if (campaign && campaign.id) {
          fetchCampaigns();
          selectCampaign(campaign.id);
        }
      }

    } catch (err) {
      console.error(err);
      setMessages(prev => [...prev, {
        role: 'model',
        content: "Sorry, I ran into an issue connecting to the API. Make sure crm-api backend is running on port 3001."
      }]);
    } finally {
      setIsLoading(false);
    }
  };

  // Find if last AI response is in confirmation phase
  const lastAiMessage = [...messages].reverse().find(m => m.role === 'model');
  const isConfirmPhase = lastAiMessage?.content?.toLowerCase().includes('confirm') || 
                          lastAiMessage?.content?.toLowerCase().includes('ready to send') ||
                          lastAiMessage?.content?.toLowerCase().includes('summary') ||
                          lastAiMessage?.actionResult?.type === 'PREVIEW_SEGMENT';

  return (
    <div className="flex h-screen bg-[#FAFAFA] text-gray-900 font-sans overflow-hidden">
      
      {/* CSS Animations Layer */}
      <style>{`
        @keyframes slideUp {
          from {
            opacity: 0;
            transform: translateY(8px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
        .animate-slide-up {
          animation: slideUp 200ms ease-out forwards;
        }
        
        @keyframes slideInFromTop {
          from {
            opacity: 0;
            transform: translateY(-8px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
        .animate-slide-in-top {
          animation: slideInFromTop 200ms ease-out forwards;
        }
      `}</style>
      
      {/* LEFT PANEL: Chat Interface (60%) */}
      <div className="w-[60%] flex flex-col border-r border-[#F3F4F6] bg-[#FAFAFA]">
        
        {/* Chat Header */}
        <header className="px-6 py-4 border-b border-[#F3F4F6] flex items-center justify-between bg-white shadow-sm z-10">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-indigo-50 rounded-xl text-[#4F46E5]">
              <Sparkles className="h-5 w-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-lg font-semibold text-gray-900 leading-tight">Campaign Copilot</h1>
                <span className={`h-2 w-2 rounded-full ${
                  connectionStatus === 'online' ? 'bg-[#4F46E5] animate-pulse' : 'bg-red-500'
                }`}></span>
              </div>
              <span className="text-xs text-gray-500">
                {connectionStatus === 'online' ? 'Agent Active' : 'API Connection Error'}
              </span>
            </div>
          </div>
          
          <button 
            onClick={() => {
              setMessages([{
                role: 'model',
                content: "Chat cleared! Let's start fresh. What target goal do you want to achieve for your next marketing campaign?"
              }]);
              disconnectSSE();
              setActiveCampaignId(null);
              setLiveStats(null);
              setRecentEvents([]);
            }}
            className="p-1.5 hover:bg-gray-50 rounded-full text-gray-400 hover:text-gray-650 transition-all duration-205 ease-out border-0 cursor-pointer flex items-center justify-center"
            title="Reset Chat"
          >
            <RefreshCw className="h-4 w-4" />
          </button>
        </header>

        {/* Chat Messages Log */}
        <div className="flex-1 overflow-y-auto px-6 py-6 space-y-6 scrollbar-thin scrollbar-thumb-gray-250">
          {messages.map((msg, index) => {
            const isUser = msg.role === 'user';
            
            return (
              <div 
                key={index} 
                className={`flex gap-3 max-w-[85%] animate-slide-up ${isUser ? 'ml-auto flex-row-reverse' : ''}`}
              >
                {/* Avatar */}
                {!isUser ? (
                  <div className="h-7 w-7 rounded-full bg-[#4F46E5] text-white flex items-center justify-center shrink-0 shadow-sm">
                    <span className="text-xs">✦</span>
                  </div>
                ) : (
                  <div className="h-7 w-7 rounded-full bg-indigo-50 text-[#4F46E5] border border-indigo-100 flex items-center justify-center shrink-0 font-semibold text-xs shadow-sm">
                    U
                  </div>
                )}

                {/* Bubble */}
                <div className="space-y-3 flex-1">
                  <div className={`p-4 rounded-2xl ${
                    isUser 
                      ? 'bg-[#4F46E5] text-white rounded-br-sm max-w-sm ml-auto px-4 py-2.5 shadow-sm' 
                      : 'bg-white border border-[#F3F4F6] text-gray-800 rounded-bl-sm max-w-lg px-4 py-3 shadow-sm'
                  }`}>
                    {isUser ? (
                      <p className="text-sm leading-relaxed">{msg.content}</p>
                    ) : (
                      <div className="space-y-2">
                        {renderMarkdown(msg.content)}
                      </div>
                    )}
                  </div>

                  {/* Render Action Result Cards if present */}
                  {msg.actionResult && (
                    <div className="pl-2 pr-4 transition-all duration-200">
                      {msg.actionResult.type === 'PREVIEW_SEGMENT' && (
                        <div className="bg-white border-l-[3px] border-[#4F46E5] rounded-xl p-4 shadow-sm border border-gray-100 border-l-0 flex items-start gap-3.5">
                          <div className="p-2 bg-indigo-50 rounded-xl text-[#4F46E5] mt-0.5">
                            <Users className="h-5 w-5" />
                          </div>
                          <div className="space-y-1.5 flex-1">
                            <h4 className="text-xs font-semibold text-gray-400">Target Segment Found</h4>
                            <div className="text-2xl font-bold text-gray-900">
                              {msg.actionResult.data.count} <span className="text-sm font-medium text-gray-500">customers</span>
                            </div>
                            
                            {msg.actionResult.data.sample && msg.actionResult.data.sample.length > 0 && (
                              <div className="text-xs text-gray-500 pt-1.5 border-t border-gray-50 mt-1">
                                <span className="font-semibold text-gray-700">Sample: </span>
                                {msg.actionResult.data.sample.join(', ')}
                              </div>
                            )}
                          </div>
                        </div>
                      )}

                      {msg.actionResult.type === 'CREATE_CAMPAIGN' && (
                        <div className="bg-white border-l-[3px] border-[#10B981] rounded-xl p-4 shadow-sm border border-gray-100 border-l-0 flex items-start gap-3.5">
                          <div className="p-2 bg-emerald-50 rounded-xl text-[#10B981] mt-0.5">
                            <CheckCircle2 className="h-5 w-5" />
                          </div>
                          <div className="space-y-1 flex-1">
                            <h4 className="text-xs font-semibold text-gray-400">Campaign Fired Successfully</h4>
                            <div className="text-sm font-semibold text-gray-900">{msg.actionResult.data.name}</div>
                            {msg.actionResult.data.guardrail_message && (
                              <div className="bg-amber-50 border border-amber-100 rounded-lg px-3 py-2 text-amber-700 text-xs">
                                {msg.actionResult.data.guardrail_message}
                              </div>
                            )}
                            <p className="text-xs text-gray-500 mt-1">
                              Channel: <span className="uppercase text-emerald-600 font-semibold">{msg.actionResult.data.channel}</span> | Message copy dispatched to mock carrier queue.
                            </p>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
          
          {isLoading && (
            <div className="flex gap-3 max-w-[80%] animate-slide-up">
              <div className="h-7 w-7 rounded-full bg-[#4F46E5] text-white flex items-center justify-center shrink-0 shadow-sm">
                <span className="text-xs">✦</span>
              </div>
              <div className="bg-white border border-[#F3F4F6] rounded-2xl rounded-bl-sm px-4 py-3 shadow-sm flex items-center gap-1.5">
                <span className="h-2 w-2 bg-[#4F46E5] rounded-full animate-bounce"></span>
                <span className="h-2 w-2 bg-[#4F46E5] rounded-full animate-bounce [animation-delay:0.2s]"></span>
                <span className="h-2 w-2 bg-[#4F46E5] rounded-full animate-bounce [animation-delay:0.4s]"></span>
              </div>
            </div>
          )}
          
          <div ref={messagesEndRef} />
        </div>

        {/* Send Campaign Action Button Panel */}
        {isConfirmPhase && !isLoading && (
          <div className="px-6 py-3 bg-indigo-50/10 border-t border-[#F3F4F6] flex justify-center animate-slide-up z-10">
            <button
              onClick={() => handleSendMessage("Send the campaign now")}
              className="px-6 py-2.5 bg-[#4F46E5] hover:bg-indigo-700 active:scale-[0.95] text-white font-semibold rounded-full shadow-sm flex items-center gap-2 text-sm transition-all duration-200 ease-out border-0 cursor-pointer"
            >
              <Play className="h-4 w-4 fill-current" />
              Approve & Send Campaign
            </button>
          </div>
        )}

        {/* Chat Input Bar */}
        <div className="px-4 py-3 border-t border-[#F3F4F6] bg-white z-10">
          <form 
            onSubmit={(e) => {
              e.preventDefault();
              handleSendMessage();
            }}
            className="flex items-center gap-2 w-full"
          >
            <div className="flex-1 relative">
              <input
                type="text"
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                placeholder="Ask Copilot (e.g. 'Target beauty shoppers with 3+ orders...')"
                className="w-full bg-white border border-gray-200 focus:border-[#4F46E5] focus:ring-2 focus:ring-indigo-500/20 focus:outline-none rounded-full shadow-sm px-5 py-2 text-sm text-gray-900 placeholder-gray-400 transition-all duration-200 ease-out"
                disabled={isLoading}
              />
            </div>
            <button
              type="submit"
              disabled={isLoading || !inputText.trim()}
              className="shrink-0 bg-[#4F46E5] hover:bg-indigo-700 active:scale-95 disabled:bg-gray-100 disabled:text-gray-400 text-white rounded-full w-9 h-9 flex items-center justify-center transition-all duration-200 ease-out border-0 cursor-pointer"
            >
              <Send className="h-4 w-4" />
            </button>
          </form>
        </div>
      </div>

      {/* RIGHT PANEL: Live Dashboard & Campaign History (40%) */}
      <div className="w-[40%] flex flex-col bg-white overflow-y-auto border-l border-[#F3F4F6] scrollbar-thin">
        
        {/* Dashboard Section */}
        <div className="p-6 border-b border-[#F3F4F6]">
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-2">
              <BarChart3 className="h-5 w-5 text-[#4F46E5]" />
              <h2 className="text-sm font-semibold text-gray-900">Live Delivery Feed</h2>
            </div>
            {sseRef.current ? (
              <div className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full bg-[#10B981] animate-pulse"></span>
                <span className="text-xs font-semibold text-green-600">Streaming</span>
              </div>
            ) : (
              <div className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full bg-gray-300"></span>
                <span className="text-xs font-medium text-gray-400">Connecting...</span>
              </div>
            )}
          </div>

          {liveStats ? (
            <div className="space-y-5">
              
              {/* Stats Grid (2x2) */}
              <div className="grid grid-cols-2 gap-3">
                
                {/* Sent */}
                <div className="bg-white border border-gray-100 rounded-xl p-4 shadow-sm hover:shadow-md transition-all duration-200 ease-out relative">
                  <div className="absolute top-4 right-4">
                    <Smartphone className="h-4 w-4 text-gray-400" />
                  </div>
                  <div className="text-3xl font-bold text-gray-900">
                    <AnimatedCounter value={liveStats.sent} />
                  </div>
                  <div className="text-xs uppercase tracking-widest text-gray-400 mt-1">Dispatched</div>
                </div>

                {/* Delivered */}
                <div className="bg-white border border-gray-100 rounded-xl p-4 shadow-sm hover:shadow-md transition-all duration-200 ease-out relative">
                  <div className="absolute top-4 right-4">
                    <MailCheck className="h-4 w-4 text-emerald-500" />
                  </div>
                  <div className="text-3xl font-bold text-emerald-600">
                    <AnimatedCounter value={liveStats.delivered} />
                    {liveStats.sent > 0 && (
                      <span className="text-xs font-medium text-gray-400 ml-1">
                        ({Math.round((liveStats.delivered / liveStats.sent) * 100)}%)
                      </span>
                    )}
                  </div>
                  <div className="text-xs uppercase tracking-widest text-gray-400 mt-1">Delivered</div>
                </div>

                {/* Opened */}
                <div className="bg-white border border-gray-100 rounded-xl p-4 shadow-sm hover:shadow-md transition-all duration-200 ease-out relative">
                  <div className="absolute top-4 right-4">
                    <Eye className="h-4 w-4 text-indigo-400/80" />
                  </div>
                  <div className="text-3xl font-bold text-gray-900">
                    <AnimatedCounter value={liveStats.opened} />
                    {liveStats.delivered > 0 && (
                      <span className="text-xs font-medium text-gray-400 ml-1">
                        ({Math.round((liveStats.opened / liveStats.delivered) * 100)}%)
                      </span>
                    )}
                  </div>
                  <div className="text-xs uppercase tracking-widest text-gray-400 mt-1">Opened</div>
                </div>

                {/* Failed */}
                <div className="bg-white border border-gray-100 rounded-xl p-4 shadow-sm hover:shadow-md transition-all duration-200 ease-out relative">
                  <div className="absolute top-4 right-4">
                    <XCircle className="h-4 w-4 text-red-400/80" />
                  </div>
                  <div className="text-3xl font-bold text-red-500">
                    <AnimatedCounter value={liveStats.failed} />
                  </div>
                  <div className="text-xs uppercase tracking-widest text-gray-400 mt-1">Failed</div>
                </div>

              </div>

              {/* Guardrail skipped note */}
              {liveStats.guardrail_skipped > 0 && (
                <div className="mt-3 flex items-center gap-2 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2">
                  <AlertCircle className="h-3.5 w-3.5 text-amber-500 shrink-0" />
                  <span className="text-xs text-amber-700">
                    <strong>{liveStats.guardrail_skipped}</strong> customer{liveStats.guardrail_skipped > 1 ? 's' : ''} skipped by guardrail — contacted within last 24h
                  </span>
                </div>
              )}

              {/* Progress visualizer */}
              {liveStats.sent > 0 && (
                <div className="space-y-1.5 mt-4">
                  <div className="flex justify-between items-center text-xs text-gray-400">
                    <span>Delivery Rate</span>
                    <span className="font-semibold text-gray-700">
                      {Math.round((liveStats.delivered / liveStats.sent) * 100)}%
                    </span>
                  </div>
                  <div className="h-1.5 w-full bg-gray-100 rounded-full overflow-hidden">
                    <div 
                      style={{ width: `${(liveStats.delivered / liveStats.sent) * 100}%` }}
                      className="bg-indigo-500 h-full transition-all duration-700 ease-out"
                    ></div>
                  </div>
                </div>
              )}

              {/* Scrolling Delivery Event Log */}
              <div className="mt-6 space-y-2">
                <h4 className="text-xs uppercase tracking-widest text-gray-400 mb-2">
                  Live Activity
                </h4>
                <div className="space-y-2 max-h-[190px] overflow-y-auto pr-1">
                  {recentEvents.length === 0 ? (
                    <p className="text-gray-400 text-center py-4 italic text-xs">Waiting for events...</p>
                  ) : (
                    [...recentEvents].reverse().map((evt, idx) => {
                      let badgeStyle = 'bg-gray-50 text-gray-500';
                      if (evt.status === 'DELIVERED') badgeStyle = 'bg-emerald-50 text-emerald-700';
                      else if (evt.status === 'OPENED') badgeStyle = 'bg-indigo-50 text-indigo-700';
                      else if (evt.status === 'FAILED') badgeStyle = 'bg-red-50 text-red-500';
                      
                      return (
                        <div 
                          key={evt.message_id || idx} 
                          className="flex justify-between items-center py-2 border-b border-gray-50 animate-slide-in-top"
                        >
                          <div className="space-y-0.5">
                            <div className="text-sm font-medium text-gray-900">{evt.customer_name}</div>
                            <div className="text-xs text-gray-400">
                              {new Date(evt.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                            </div>
                          </div>
                          <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${badgeStyle}`}>
                            {evt.status}
                          </span>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>

            </div>
          ) : (
            <div className="h-[150px] border border-dashed border-gray-200 rounded-xl flex flex-col items-center justify-center text-gray-400 space-y-2 bg-white">
              <BarChart3 className="h-8 w-8 text-gray-300 animate-pulse" />
              <p className="text-xs">No active campaign stream connected.</p>
            </div>
          )}
        </div>

        {/* Campaign History List */}
        <div className="flex-1 p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-xs uppercase tracking-widest text-gray-400 mb-2">Campaign History</h3>
            <button 
              onClick={fetchCampaigns} 
              className="p-1 hover:bg-gray-100 rounded-full text-gray-400 hover:text-gray-650 transition-colors border-0 cursor-pointer"
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </button>
          </div>

          <div className="space-y-2.5">
            {campaigns.length === 0 ? (
              <p className="text-xs text-gray-400 text-center py-6">No previous campaigns found.</p>
            ) : (
              campaigns.map((camp) => {
                const isActive = camp.id === activeCampaignId;
                const isWhatsapp = camp.channel?.toLowerCase() === 'whatsapp';
                
                return (
                  <div
                    key={camp.id}
                    onClick={() => {
                      selectCampaign(camp.id);
                      setExpandedCampaignId(camp.id);
                      fetchInspectorData(camp.id);
                    }}
                    className={`p-3 rounded-xl border transition-all duration-200 ease-out cursor-pointer text-left shadow-sm ${
                      isActive 
                        ? 'bg-white border-[#4F46E5] ring-2 ring-indigo-500/10' 
                        : 'bg-white border-gray-100 hover:border-gray-200 hover:shadow-md'
                    }`}
                  >
                    <div className="flex justify-between items-start">
                      <h4 className="text-sm font-medium text-gray-900 truncate max-w-[70%]">
                        {camp.name}
                      </h4>
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                        isWhatsapp 
                          ? 'bg-green-50 text-green-700' 
                          : 'bg-blue-50 text-blue-700'
                      }`}>
                        {isWhatsapp ? 'WHATSAPP' : 'SMS'}
                      </span>
                    </div>

                    <p className="text-xs text-gray-400 truncate mt-1">
                      "{camp.message}"
                    </p>

                    <div className="flex justify-between items-center text-[10px] text-gray-400 pt-2.5 mt-2.5 border-t border-gray-50">
                      <div className="flex items-center gap-1">
                        <Calendar className="h-3 w-3" />
                        {new Date(camp.created_at).toLocaleDateString()}
                      </div>
                      <div className="flex gap-2">
                        <span>Sent: <strong>{camp.stats?.sent || 0}</strong></span>
                        <span>Delivered: <strong className="text-emerald-600">{camp.stats?.delivered || 0}</strong></span>
                        <span>Opened: <strong className="text-[#4F46E5]">{camp.stats?.opened || 0}</strong></span>
                      </div>
                    </div>

                    {/* Inline Campaign Inspector Panel */}
                    {expandedCampaignId === camp.id && (
                      <div
                        onClick={(e) => e.stopPropagation()}
                        className="mt-4 pt-4 border-t border-gray-100 space-y-3 cursor-default"
                      >
                        <div className="flex items-center justify-between">
                          <span className="text-sm font-medium text-gray-700">Who did we reach?</span>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setExpandedCampaignId(null);
                            }}
                            className="text-xs text-gray-400 hover:text-gray-650 px-2 py-1 rounded hover:bg-gray-50 border-0 cursor-pointer bg-transparent transition-colors duration-150 flex items-center justify-center font-medium"
                          >
                            Close
                          </button>
                        </div>

                        {isInspectorLoading ? (
                          <div className="flex justify-center py-6">
                            <span className="h-5 w-5 border-2 border-[#4F46E5] border-t-transparent rounded-full animate-spin"></span>
                          </div>
                        ) : inspectorData.length === 0 ? (
                          <p className="text-xs text-gray-400 italic py-2 text-center">No data available yet.</p>
                        ) : (
                          <div className="space-y-2 max-h-[200px] overflow-y-auto pr-1">
                            {inspectorData.map((msg, index) => {
                              let badgeStyle = 'bg-gray-50 text-gray-500';
                              if (msg.status === 'DELIVERED') badgeStyle = 'bg-emerald-50 text-emerald-700';
                              else if (msg.status === 'OPENED') badgeStyle = 'bg-indigo-50 text-indigo-700';
                              else if (msg.status === 'FAILED') badgeStyle = 'bg-red-50 text-red-500';

                              return (
                                <div key={index} className="flex justify-between items-start py-2 border-b border-gray-50">
                                  <div className="space-y-0.5">
                                    <div className="text-xs font-medium text-gray-900">{msg.customer_name}</div>
                                    <div className="text-xs text-gray-400">{msg.filter_match_reason}</div>
                                  </div>
                                  <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${badgeStyle}`}>
                                    {msg.status}
                                  </span>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>

      </div>

    </div>
  );
}

export default App;

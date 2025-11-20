using UnityEngine;
using SocketIOClient;
using SocketIOClient.Transport;
using System.Threading.Tasks;
using System;
using SocketIO.Core;
using Unity.WebRTC;
using System.Collections;
using System.Text;
using System.Collections.Generic;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization; 
using System.Threading;
using System.Text.RegularExpressions;
using UnityEngine.SceneManagement; 

// =========================================================
// データ構造クラス
// =========================================================

// ICE CandidateとSDPメッセージのクラスはJsonNodeベースのパースに切り替えたため不要

// ハンドランドマークデータ (DataChannel受信用)
[System.Serializable]
public class Landmark
{
    // [SerializeField] // UnityのJsonUtility互換性を高めるため、必要に応じて付与（現状のSystem.Text.Jsonでは必須ではない）
    [JsonPropertyName("x")]
    public float x;
    [JsonPropertyName("y")]
    public float y;
    [JsonPropertyName("z")]
    public float z;
}

// =========================================================
// メインクラス (HandClient)
// =========================================================
public class HandClient : MonoBehaviour
{
    public static HandClient Instance { get; private set; }
    // 外部のスクリプト（SphereControllerなど）が購読するイベント
    public event Action<List<List<Landmark>>> OnLandmarksReceived; 

    private SocketIOClient.SocketIO socket;
    private const string ServerUrl = "wss://g1m-pwa.onrender.com";
    private RTCPeerConnection _peerConnection;
    private RTCDataChannel _dataChannel;
    
    // Candidateのバッファリング用構造体
    private struct CandidateData
    {
        public string candidate;
        public string sdpMid;
        public int sdpMLineIndex;
    }
    private Queue<CandidateData> _iceCandidateBuffer = new Queue<CandidateData>();
    private SynchronizationContext unityContext;

    void Awake()
    {
        if (Instance == null)
        {
            Instance = this;
        }
        else if (Instance != this)
        {
            Destroy(gameObject);
            return;
        }
        unityContext = SynchronizationContext.Current;
    }

    void Start()
    {
        InitializeSocketIO();
    }

    void Update()
    {
        WebRTC.Update();
    }

    // Socket.IOの初期化ロジック (変更なし)
    async void InitializeSocketIO()
    {
        if (socket != null && socket.Connected)
        {
            await socket.DisconnectAsync();
        }

        var uri = new Uri(ServerUrl);
        socket = new SocketIOClient.SocketIO(uri, new SocketIOOptions
        {
            EIO = EngineIO.V4,
            Transport = TransportProtocol.WebSocket,
            ConnectionTimeout = TimeSpan.FromSeconds(20)
        });

        socket.On("offer", response => {
            if (this != null && unityContext != null)
            {
                unityContext.Post(_ => StartCoroutine(HandleOfferCoroutine(response)), null);
            }
        });

        socket.On("candidate", response => {
            if (this != null && unityContext != null)
            {
                unityContext.Post(_ => StartCoroutine(HandleCandidateCoroutine(response)), null);
            }
        });

        socket.On("webrtc_close", response =>
        {
            if (this != null && unityContext != null)
            {
                unityContext.Post(_ => {
                    Debug.Log("Received webrtc_close event from server.");
                    CloseWebRTCConnection();
                }, null);
            }
        });

        socket.OnConnected += async (sender, e) =>
        {
            Debug.Log("Socket.IO Connected! ");
            await socket.EmitAsync("register_role", "unity");
            Debug.Log("Registered as 'unity' client.");
            if (this != null && unityContext != null)
            {
                unityContext.Post(_ => InitializeWebRTC(), null);
            }
        };

        socket.OnDisconnected += async (sender, e) =>
        {
            if (this != null && unityContext != null)
            {
                unityContext.Post(_ => {
                    Debug.Log($"Socket.IO Disconnected! Reason: {e}");
                    CloseWebRTCConnection();
                }, null);
            }
            await Task.Delay(3000);
            await ConnectSocketAsync();
        };

        socket.OnError += (sender, e) => Debug.LogError($"Socket.IO Error: {e}");

        await ConnectSocketAsync();
    }

    // WebRTCの初期化ロジック
    void InitializeWebRTC()
    {
        CloseWebRTCConnection();
        _iceCandidateBuffer.Clear();

        var configuration = new RTCConfiguration
        {
            iceServers = new RTCIceServer[]
            {
                new RTCIceServer { urls = new string[] { "stun:stun.l.google.com:19302" } },
            }
        };
        _peerConnection = new RTCPeerConnection(ref configuration);

        _peerConnection.OnDataChannel += channel =>
        {
            _dataChannel = channel;
            _dataChannel.OnOpen += () => unityContext.Post(_ => Debug.Log("WebRTC DataChannel is now open! ❤️ データチャネル開通"), null);
            _dataChannel.OnClose += () => unityContext.Post(_ => Debug.Log("WebRTC DataChannel is closed."), null);
            
            // ★★★ データ受信ロジックの修正 ★★★
            _dataChannel.OnMessage += bytes =>
            {
                unityContext.Post(_ =>
                {
                    string handData = Encoding.UTF8.GetString(bytes);
                    if (string.IsNullOrEmpty(handData)) return;

                    try
                    {
                        // PWAから送信される生のJSON配列を、JsonNode経由で確実にList<List<Landmark>>にデシリアライズ
                        var options = new JsonSerializerOptions 
                        { 
                            PropertyNameCaseInsensitive = true,
                            AllowTrailingCommas = true // 末尾のカンマなどを許容するオプション
                        };

                        // JsonNode.Parseで生のJSON文字列を一度パース
                        var jsonNode = JsonNode.Parse(handData);
                        
                        // JsonNodeから直接List<List<Landmark>>へのデシリアライズを試みる
                        var multiHandLandmarks = jsonNode.Deserialize<List<List<Landmark>>>(options);

                        if (multiHandLandmarks != null)
                        {
                            Instance.OnLandmarksReceived?.Invoke(multiHandLandmarks);
                            // Debug.Log($"✅ Hand landmarks received and invoked. Hands count: {multiHandLandmarks.Count}"); // 成功時のログは頻繁なのでコメントアウト
                        }
                        else
                        {
                            Debug.LogError("🔴 DataChannel JSON parse failed: Deserialized object is null.");
                        }
                    }
                    catch (Exception ex)
                    {
                        string snippet = handData.Length > 200 ? handData.Substring(0, 200) : handData;
                        Debug.LogError($"🔴 DataChannel JSON parse exception: {ex.Message}. Snippet: {snippet}...");
                    }
                }, null);
            };
            // ★★★ 修正終わり ★★★
        };
        
        _peerConnection.OnIceCandidate = cand =>
        {
            if (cand != null && socket.Connected)
            {
                var candStr = cand.Candidate;

                if (!string.IsNullOrEmpty(candStr) && candStr.StartsWith("a="))
                    candStr = candStr.Substring(2);
                
                if (string.IsNullOrEmpty(candStr)) return;

                var obj = new
                {
                    candidate = candStr, 
                    sdpMid = string.IsNullOrEmpty(cand.SdpMid) ? "0" : cand.SdpMid,
                    sdpMLineIndex = cand.SdpMLineIndex.HasValue ? cand.SdpMLineIndex.Value : 0
                };
                
                socket.EmitAsync("candidate", obj);
            }
        };

        _peerConnection.OnConnectionStateChange += state =>
        {
            Debug.Log($"WebRTC connection state: {state}");
            if (state == RTCPeerConnectionState.Disconnected || state == RTCPeerConnectionState.Failed)
            {
                Debug.LogWarning("WebRTC connection failed or disconnected. Closing.");
                CloseWebRTCConnection();
                socket.EmitAsync("webrtc_close");
            }
            else if (state == RTCPeerConnectionState.Connected)
            {
                 Debug.Log("WebRTC connection state: Connected ✅");
            }
        };
    }

    private IEnumerator HandleOfferCoroutine(SocketIOResponse response)
    {
        // ... (Offer受信ロジック: 変更なし) ...
        Debug.Log("❤️ PWAからOfferを受信しました。");
        if (_peerConnection == null)
        {
            Debug.LogError("PeerConnection is not initialized. Cannot handle offer.");
            yield break;
        }

        RTCSessionDescription sdp = default;
        string offerJson = string.Empty;
        
        try
        {
            var offerJsonNode = response.GetValue<System.Text.Json.Nodes.JsonNode>(0);
            offerJson = offerJsonNode.ToJsonString();
            
            var node = JsonNode.Parse(offerJson);
            
            if (node?["sdp"]?.GetValue<string>() is string sdpValue && !string.IsNullOrEmpty(sdpValue))
            {
                sdp = new RTCSessionDescription
                {
                    type = RTCSdpType.Offer,
                    sdp = sdpValue
                };
            }
            else
            {
                Debug.LogError("Offer SDP is null or empty after JsonNode parsing. Raw JSON: " + offerJson);
                yield break;
            }
        }
        catch (Exception ex)
        {
            Debug.LogError($"Offer JSON parse exception: {ex.Message}. Raw JSON: {offerJson}");
            yield break;
        }

        var op1 = _peerConnection.SetRemoteDescription(ref sdp);
        yield return op1;
        if (op1.IsError)
        {
            Debug.LogError($"SetRemoteDescription failed: {op1.Error.message}");
            yield break;
        }

        while (_iceCandidateBuffer.Count > 0)
        {
            CandidateData candidateMsg = _iceCandidateBuffer.Dequeue();
            Debug.Log($"Applying buffered candidate. Buffer size remaining: {_iceCandidateBuffer.Count}");
            yield return AddCandidate(candidateMsg);
        }

        var op2 = _peerConnection.CreateAnswer();
        yield return op2;
        if (op2.IsError)
        {
            Debug.LogError($"CreateAnswer failed: {op2.Error.message}");
            yield break;
        }
        var answer = op2.Desc;

        var op3 = _peerConnection.SetLocalDescription(ref answer);
        yield return op3;
        if (op3.IsError)
        {
            Debug.LogError($"SetLocalDescription failed: {op3.Error.message}");
            yield break;
        }

        yield return _SendAnswerAsync(answer).AsCoroutine();
        Debug.Log("❤️ Answerを作成し、サーバーに送信しました。");
    }

    private async Task _SendAnswerAsync(RTCSessionDescription answer)
    {
        var answerObj = new
        {
            type = "answer",
            sdp = answer.sdp
        };
        await socket.EmitAsync("answer", answerObj);
    }

    private IEnumerator HandleCandidateCoroutine(SocketIOResponse response)
    {
        // ... (Candidate受信ロジック: 変更なし) ...
        Debug.Log("❤️ PWAからCandidateを受信しました。");
        
        CandidateData candidateData = new CandidateData();
        string json = string.Empty;
        bool dataValid = false;

        try
        {
            var jsonNode = response.GetValue<System.Text.Json.Nodes.JsonNode>(0);
            json = jsonNode.ToJsonString();
            
            var node = JsonNode.Parse(json);
            
            if (node?["candidate"]?.GetValue<string>() is string candidateStr && !string.IsNullOrEmpty(candidateStr))
            {
                candidateData.candidate = candidateStr;
                candidateData.sdpMid = node?["sdpMid"]?.GetValue<string>() ?? "0";
                candidateData.sdpMLineIndex = node?["sdpMLineIndex"]?.GetValue<int>() ?? 0;
                dataValid = true;
            }
        }
        catch (Exception ex)
        {
            Debug.LogError($"[HandleCandidateCoroutine] JSON parse exception: {ex.Message}. Raw JSON: {json}");
            yield break; 
        }
        
        if (!dataValid)
        {
            Debug.LogError($"⚠️ Received invalid ICE candidate JSON. Missing 'candidate' field or empty value. Raw JSON: {json}");
            yield break;
        }
        
        if (_peerConnection == null || _peerConnection.RemoteDescription.sdp == null) 
        {
            _iceCandidateBuffer.Enqueue(candidateData);
            Debug.LogWarning($"PeerConnection remote description is not set yet. Candidate buffered. Current buffer size: {_iceCandidateBuffer.Count}");
        }
        else
        {
            yield return AddCandidate(candidateData);
        }
    }

    private IEnumerator AddCandidate(CandidateData candidateMsg)
    {
        // ... (Candidate追加ロジック: 変更なし) ...
        string candidateStr = candidateMsg.candidate;
        
        if (!string.IsNullOrEmpty(candidateStr))
        {
            candidateStr = candidateStr.Trim();
        }

        if (string.IsNullOrEmpty(candidateStr))
        {
            Debug.LogWarning("Candidate string is empty, skipping AddIceCandidate.");
            yield break;
        }
        
        var iceCandidateInit = new RTCIceCandidateInit
        {
            candidate = candidateStr,
            sdpMid = candidateMsg.sdpMid,
            sdpMLineIndex = candidateMsg.sdpMLineIndex
        };

        var rtcIceCandidate = new RTCIceCandidate(iceCandidateInit);
        
        if (!_peerConnection.AddIceCandidate(rtcIceCandidate))
        {
            Debug.LogError($"Failed to add ICE candidate. Candidate: {candidateStr}, SDP Mid: {candidateMsg.sdpMid}");
        }
        yield break;
    }

    private async Task ConnectSocketAsync()
    {
        if (socket.Connected) return;
        Debug.Log($"Attempting to connect to {ServerUrl}...");
        try
        {
            await socket.ConnectAsync();
        }
        catch (Exception e)
        {
            Debug.LogError($"Connection failed: {e.GetType().Name} - {e.Message}");
            await Task.Delay(5000);
            await ConnectSocketAsync();
        }
    }

    private void CloseWebRTCConnection()
    {
        if (_peerConnection != null)
        {
            _peerConnection.Close();
            _peerConnection.Dispose();
            _peerConnection = null;
            Debug.Log("WebRTC PeerConnection has been closed and disposed.");
        }
        _dataChannel = null;
    }

    void OnDestroy()
    {
        CloseWebRTCConnection();
        if (socket != null && socket.Connected)
        {
            socket.DisconnectAsync();
        }
    }
}

// TaskをCoroutineとして実行するための拡張メソッド (変更なし)
public static class TaskExtensions
{
    public static Coroutine AsCoroutine(this Task task)
    {
        if (HandClient.Instance == null)
        {
            Debug.LogError("Cannot run Task as Coroutine: HandClient.Instance is null.");
            return null;
        }
        return HandClient.Instance.StartCoroutine(RunTask(task));
    }

    private static IEnumerator RunTask(Task task)
    {
        while (!task.IsCompleted)
        {
            yield return null;
        }
        if (task.IsFaulted)
        {
            Debug.LogError("Task failed: " + task.Exception);
        }
    }
}
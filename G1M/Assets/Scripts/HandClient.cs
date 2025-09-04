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
using System.Threading;
using System.Text.RegularExpressions;

// PWAから送信されるOfferのJSON形式に対応するクラス
[System.Serializable]
public class SdpMessage
{
    public string sdp;
    public string type;
}

// PWAから送信されるCandidateのJSON形式に対応するクラス
[System.Serializable]
public class SdpCandidate
{
    public string candidate;
    public string sdpMid;
    public int? sdpMLineIndex;
    // PWAからの候補に含まれる可能性あり
    public string ufrag;
    public string networkId;
}

[System.Serializable]
public class Landmark
{
    public float x;
    public float y;
    public float z;
}

[System.Serializable]
public class HandLandmarksListWrapper
{
    public List<List<Landmark>> multiHandLandmarks;
}

public class HandClient : MonoBehaviour
{
    private SocketIOClient.SocketIO socket;
    private const string ServerUrl = "wss://g1m-pwa.onrender.com";

    private RTCPeerConnection _peerConnection;
    private RTCDataChannel _dataChannel;
    private Queue<SdpCandidate> _iceCandidateBuffer = new Queue<SdpCandidate>();

    public static event Action<List<List<Landmark>>> OnLandmarksReceived;

    private SynchronizationContext unityContext;

    void Awake()
    {
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
            // 修正点: Socket.IO接続成功後、即座にWebRTCを初期化
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
            _dataChannel.OnOpen += () => Debug.Log("WebRTC DataChannel is now open! ❤️ DataChannel開通");
            _dataChannel.OnClose += () => Debug.Log("WebRTC DataChannel is closed.");
            _dataChannel.OnMessage += bytes =>
            {
                string handData = Encoding.UTF8.GetString(bytes);
                try
                {
                    var parsedData = JsonUtility.FromJson<HandLandmarksListWrapper>(
                        "{\"multiHandLandmarks\":" + handData + "}");
                    if (parsedData != null && parsedData.multiHandLandmarks != null)
                    {
                        OnLandmarksReceived?.Invoke(parsedData.multiHandLandmarks);
                    }
                }
                catch (Exception ex)
                {
                    string snippet = handData.Length > 200 ? handData.Substring(0, 200) : handData;
                    Debug.LogError($"JSON parse error: {ex.Message} -> {snippet}...");
                }
            };
        };
        
        _peerConnection.OnIceCandidate = cand =>
        {
            if (cand != null && socket.Connected)
            {
                var candStr = cand.Candidate;

                if (!string.IsNullOrEmpty(candStr) && candStr.StartsWith("a="))
                    candStr = candStr.Substring(2);

                var obj = new
                {
                    candidate = candStr ?? "",
                    sdpMid = string.IsNullOrEmpty(cand.SdpMid) ? "" : cand.SdpMid,
                    sdpMLineIndex = cand.SdpMLineIndex.HasValue && cand.SdpMLineIndex.Value >= 0 ? cand.SdpMLineIndex.Value : 0
                };
                
                string json = JsonSerializer.Serialize(obj);
                Debug.Log($"✅ 送信するCandidate JSON: {json}");
                
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
            }
        };
    }

    private IEnumerator HandleOfferCoroutine(SocketIOResponse response)
    {
        Debug.Log("❤️ PWAからOfferを受信しました。");
        
        // PeerConnectionが初期化されていなければ、ここで初期化
        if (_peerConnection == null)
        {
            unityContext.Post(_ => InitializeWebRTC(), null);
            // InitializeWebRTC()が非同期的に実行されるため、少し待つ
            // ただし、完全に初期化されるのを保証するわけではない
            yield return new WaitForSeconds(0.1f);
        }

        RTCSessionDescription sdp = default;
        string offerJson;
        try
        {
            offerJson = response.GetValue<System.Text.Json.Nodes.JsonNode>(0).ToString();
            Debug.Log($"Offer JSON string received: {offerJson}");
            SdpMessage offerMsg = JsonUtility.FromJson<SdpMessage>(offerJson);
            
            if (string.IsNullOrEmpty(offerMsg?.sdp))
            {
                Debug.LogError("Offer SDP is null or empty after parsing.");
                yield break;
            }

            sdp = new RTCSessionDescription
            {
                type = RTCSdpType.Offer,
                sdp = offerMsg.sdp
            };
        }
        catch (Exception ex)
        {
            Debug.LogError($"Offer JSON parse exception: {ex.Message}");
            yield break;
        }

        var op1 = _peerConnection.SetRemoteDescription(ref sdp);
        yield return op1;
        if (op1.IsError)
        {
            Debug.LogError($"SetRemoteDescription failed: {op1.Error.message}");
            yield break;
        }
        Debug.Log("SetRemoteDescription succeeded.");

        while (_iceCandidateBuffer.Count > 0)
        {
            SdpCandidate candidateMsg = _iceCandidateBuffer.Dequeue();
            yield return AddCandidate(candidateMsg);
        }

        var op2 = _peerConnection.CreateAnswer();
        yield return op2;
        if (op2.IsError)
        {
            Debug.LogError($"CreateAnswer failed: {op2.Error.message}");
            yield break;
        }
        Debug.Log("CreateAnswer succeeded.");
        var answer = op2.Desc;

        var op3 = _peerConnection.SetLocalDescription(ref answer);
        yield return op3;
        if (op3.IsError)
        {
            Debug.LogError($"SetLocalDescription failed: {op3.Error.message}");
            yield break;
        }
        Debug.Log("SetLocalDescription succeeded.");

        yield return _SendAnswerAsync(answer);
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
        Debug.Log("❤️ PWAからCandidateを受信しました。");
        
        SdpCandidate candidateMsg;
        try
        {
            candidateMsg = response.GetValue<SdpCandidate>(0);
            if (candidateMsg == null || string.IsNullOrEmpty(candidateMsg.candidate))
            {
                Debug.LogWarning("Received invalid ICE candidate JSON.");
                yield break;
            }
        }
        catch (Exception ex)
        {
            Debug.LogError($"[HandleCandidateCoroutine] Exception during JSON parsing: {ex.Message}");
            yield break;
        }
        
        if (_peerConnection == null || string.IsNullOrEmpty(_peerConnection.RemoteDescription.sdp))
        {
            _iceCandidateBuffer.Enqueue(candidateMsg);
            Debug.LogWarning($"PeerConnection remote description is not set yet. Candidate buffered. Current buffer size: {_iceCandidateBuffer.Count}");
        }
        else
        {
            yield return AddCandidate(candidateMsg);
        }
    }

    // 修正案のコードを適用
    private IEnumerator AddCandidate(SdpCandidate candidateMsg)
    {
        string candidateStr = candidateMsg.candidate;
        if (!string.IsNullOrEmpty(candidateStr))
        {
            // ufrag と network-id 部分を文字列から削除（強化版）
            candidateStr = Regex.Replace(candidateStr, @"\sufrag[=]?\S+", "", RegexOptions.IgnoreCase);
            candidateStr = Regex.Replace(candidateStr, @"\snetwork-id[=]?\S+", "", RegexOptions.IgnoreCase);
            candidateStr = candidateStr.Trim();
        }

        if (string.IsNullOrEmpty(candidateStr))
        {
            Debug.LogWarning("Candidate string is empty after cleaning, skipping.");
            yield break;
        }
        
        var iceCandidateInit = new RTCIceCandidateInit
        {
            candidate = candidateStr,
            sdpMid = candidateMsg.sdpMid,
            sdpMLineIndex = candidateMsg.sdpMLineIndex.HasValue ? candidateMsg.sdpMLineIndex.Value : (int?)null
        };

        var rtcIceCandidate = new RTCIceCandidate(iceCandidateInit);
        if (!_peerConnection.AddIceCandidate(rtcIceCandidate))
        {
            Debug.LogError("Failed to add ICE candidate: candidate is invalid.");
        }
        else
        {
            Debug.Log("Successfully added ICE candidate.");
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
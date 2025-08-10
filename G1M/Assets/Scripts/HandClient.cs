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
using System.Threading;

[System.Serializable]
public class SdpMessage
{
    public string sdp;
    public string type;
}

[System.Serializable]
public class SdpCandidate
{
    public string candidate;
    public string sdpMid;
    public int sdpMLineIndex;
    public string usernameFragment;
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

    public static event Action<List<List<Landmark>>> OnLandmarksReceived;
    private SynchronizationContext unityContext;

    private bool isHandlingOffer = false;

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
            if (this != null && !isHandlingOffer)
            {
                unityContext.Post(_ => StartCoroutine(HandleOfferCoroutine(response)), null);
            }
        });

        socket.On("candidate", response => {
            if (this != null)
            {
                unityContext.Post(_ => StartCoroutine(HandleCandidateCoroutine(response)), null);
            }
        });

        socket.On("webrtc_close", response =>
        {
            if (this != null)
            {
                unityContext.Post(_ => {
                    Debug.Log("Received webrtc_close event from server.");
                    CloseWebRTCConnection();
                }, null);
            }
        });

        socket.OnConnected += async (sender, e) =>
        {
            Debug.Log("Socket.IO Connected! Registered as 'unity' client.");
            await socket.EmitAsync("register_role", "unity");
            if (this != null)
            {
                unityContext.Post(_ => InitializeWebRTC(), null);
            }
        };

        socket.OnDisconnected += async (sender, e) =>
        {
            if (this != null)
            {
                unityContext.Post(_ => {
                    Debug.Log($"Socket.IO Disconnected! Reason: {e}. Attempting to reconnect in 3 seconds...");
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
            _dataChannel.OnOpen += () => Debug.Log("WebRTC DataChannel is now open! ❤️ データチャンネル開通");
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

        _peerConnection.OnIceCandidate = candidate =>
        {
            if (candidate != null && socket.Connected)
            {
                // Web PWA側が期待するJSON形式にCandidateを変換
                var candidateObj = new
                {
                    candidate = candidate.Candidate,
                    sdpMid = candidate.SdpMid,
                    sdpMLineIndex = candidate.SdpMLineIndex
                };
                var candidateJson = JsonUtility.ToJson(candidateObj);
                
                // JsonUtility.ToJson()はstring, sdpMid, sdpMLineIndexがnullの場合、JSONに出力しない
                // サーバー側が空のオブジェクトを受け取ってエラーになることを防ぐため、
                // Candidateが有効か確認してからEmitする
                if (!string.IsNullOrEmpty(candidateObj.candidate))
                {
                    Debug.Log($"Sending ICE candidate to server: {candidateJson}");
                    socket.EmitAsync("candidate", candidateJson);
                } else {
                    Debug.LogWarning("Skipping ICE candidate with empty `candidate` string.");
                }
            }
        };

        _peerConnection.OnConnectionStateChange += state =>
        {
            Debug.Log($"WebRTC connection state: {state}");
            if (state == RTCPeerConnectionState.Disconnected || state == RTCPeerConnectionState.Failed || state == RTCPeerConnectionState.Closed)
            {
                Debug.LogWarning("WebRTC connection failed, disconnected, or closed. Closing and disposing.");
                CloseWebRTCConnection();
            }
        };
    }

    private IEnumerator HandleOfferCoroutine(SocketIOResponse response)
    {
        isHandlingOffer = true;
        Debug.Log("❤️ PWAからOfferを受信しました。");

        if (_peerConnection == null)
        {
            Debug.LogError("PeerConnection is not initialized. Cannot handle offer.");
            isHandlingOffer = false;
            yield break;
        }

        RTCSessionDescription sdp = default;
        try
        {
            string offerJson = response.GetValue<System.Text.Json.Nodes.JsonNode>(0).ToString();
            Debug.Log($"Offer JSON string received: {offerJson}");
            SdpMessage offerMsg = JsonUtility.FromJson<SdpMessage>(offerJson);
            
            if (string.IsNullOrEmpty(offerMsg?.sdp))
            {
                Debug.LogError("Offer SDP is null or empty after parsing.");
                isHandlingOffer = false;
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
            isHandlingOffer = false;
            yield break;
        }

        var op1 = _peerConnection.SetRemoteDescription(ref sdp);
        yield return op1;
        if (op1.IsError)
        {
            Debug.LogError($"SetRemoteDescription failed: {op1.Error.message}");
            isHandlingOffer = false;
            yield break;
        }
        Debug.Log("SetRemoteDescription succeeded. Creating answer...");

        var op2 = _peerConnection.CreateAnswer();
        yield return op2;
        if (op2.IsError)
        {
            Debug.LogError($"CreateAnswer failed: {op2.Error.message}");
            isHandlingOffer = false;
            yield break;
        }
        var answer = op2.Desc;

        var op3 = _peerConnection.SetLocalDescription(ref answer);
        yield return op3;
        if (op3.IsError)
        {
            Debug.LogError($"SetLocalDescription failed: {op3.Error.message}");
            isHandlingOffer = false;
            yield break;
        }
        Debug.Log("SetLocalDescription succeeded. Sending answer to server...");

        var answerObj = new {
            sdp = answer.sdp,
            type = answer.type.ToString().ToLower()
        };
        string answerJson = JsonUtility.ToJson(answerObj);
        Debug.Log($"Sending answer JSON: {answerJson}");

        var emitTask = socket.EmitAsync("answer", answerJson);
        while (!emitTask.IsCompleted)
        {
            yield return null;
        }
        if (emitTask.IsFaulted)
        {
            Debug.LogError($"Failed to send answer: {emitTask.Exception?.GetBaseException().Message}");
        }

        Debug.Log("❤️ Answerを作成し、サーバーに送信しました。");
        isHandlingOffer = false;
    }

    private IEnumerator HandleCandidateCoroutine(SocketIOResponse response)
    {
        Debug.Log("❤️ PWAからCandidateを受信しました。");
        if (_peerConnection == null)
        {
            Debug.LogWarning("PeerConnection is not initialized yet. Discarding ICE candidate.");
            yield break;
        }

        try
        {
            string candidateJson = response.GetValue<System.Text.Json.Nodes.JsonNode>(0).ToString();
            SdpCandidate candidateMsg = JsonUtility.FromJson<SdpCandidate>(candidateJson);

            if (candidateMsg != null && !string.IsNullOrEmpty(candidateMsg.candidate))
            {
                var iceCandidateInit = new RTCIceCandidateInit
                {
                    candidate = candidateMsg.candidate,
                    sdpMid = candidateMsg.sdpMid,
                    sdpMLineIndex = candidateMsg.sdpMLineIndex
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
            }
            else
            {
                Debug.LogWarning("Received invalid ICE candidate JSON.");
            }
        }
        catch (Exception ex)
        {
            Debug.LogError($"[HandleCandidateCoroutine] Exception: {ex.Message}");
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
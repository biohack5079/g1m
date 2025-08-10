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
            ConnectionTimeout = new TimeSpan(0, 0, 20)
        });

        // Connect前にイベント登録
        socket.On("offer", response => StartCoroutine(HandleOfferAsync(response)));
        socket.On("candidate", response => StartCoroutine(HandleCandidateAsync(response)));
        socket.On("webrtc_close", response =>
        {
            Debug.Log("Received webrtc_close event from server.");
            CloseWebRTCConnection();
        });

        socket.OnConnected += async (sender, e) =>
        {
            Debug.Log("Socket.IO Connected!");
            await socket.EmitAsync("register_role", "unity");
            Debug.Log("Registered as 'unity' client.");
            InitializeWebRTC();
        };

        socket.OnDisconnected += async (sender, e) =>
        {
            Debug.Log($"Socket.IO Disconnected! Reason: {e}");
            CloseWebRTCConnection();
            Debug.Log("Attempting to reconnect in 3 seconds...");
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
            _dataChannel.OnOpen += () => Debug.Log("WebRTC DataChannel is now open! (Received from PWA) ❤️ DataChannelが開通しました！");
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
                catch (System.Exception ex)
                {
                    string snippet = handData.Length > 200 ? handData.Substring(0, 200) : handData;
                    Debug.LogError($"JSON parse error: {ex.Message} -> Received data was: {snippet}...");
                }
            };
        };

        _peerConnection.OnIceCandidate = candidate =>
        {
            if (candidate != null && socket.Connected)
            {
                var candidateObj = new
                {
                    candidate = candidate.Candidate,
                    sdpMid = candidate.SdpMid,
                    sdpMLineIndex = candidate.SdpMLineIndex
                };
                var candidateJson = JsonUtility.ToJson(candidateObj);
                socket.EmitAsync("candidate", candidateJson);
            }
        };

        _peerConnection.OnConnectionStateChange += state =>
        {
            Debug.Log($"WebRTC connection state: {state}");
            if (state == RTCPeerConnectionState.Disconnected || state == RTCPeerConnectionState.Failed)
            {
                Debug.LogWarning("WebRTC connection failed or disconnected. Closing connection.");
                CloseWebRTCConnection();
            }
        };
    }

    // CS1626回避版 HandleOfferAsync
    private IEnumerator HandleOfferAsync(SocketIOResponse response)
    {
        Debug.Log("❤️ PWAからOfferを受信しました。");
        Debug.Log("HandleOfferAsync started.");

        if (_peerConnection == null)
        {
            Debug.LogError("PeerConnection is not initialized. Cannot handle offer.");
            yield break;
        }

        RTCSessionDescription sdp = default;

        // ---- JSONパース（yieldなし）----
        try
        {
            var offerJson = response.GetValue<string>();
            Debug.Log($"Offer JSON received: {offerJson}");
            sdp = JsonUtility.FromJson<RTCSessionDescription>(offerJson);
        }
        catch (Exception ex)
        {
            Debug.LogError($"Offer JSON parse exception: {ex.Message}");
            yield break;
        }

        // ---- SetRemoteDescription ----
        var op1 = _peerConnection.SetRemoteDescription(ref sdp);
        yield return op1;
        if (op1.IsError)
        {
            Debug.LogError($"SetRemoteDescription failed: {op1.Error.message}");
            yield break;
        }
        Debug.Log("SetRemoteDescription succeeded.");

        // ---- CreateAnswer ----
        var op2 = _peerConnection.CreateAnswer();
        yield return op2;
        if (op2.IsError)
        {
            Debug.LogError($"CreateAnswer failed: {op2.Error.message}");
            yield break;
        }
        Debug.Log("CreateAnswer succeeded.");
        var answer = op2.Desc;

        // ---- SetLocalDescription ----
        var op3 = _peerConnection.SetLocalDescription(ref answer);
        yield return op3;
        if (op3.IsError)
        {
            Debug.LogError($"SetLocalDescription failed: {op3.Error.message}");
            yield break;
        }
        Debug.Log("SetLocalDescription succeeded.");

        // ---- Answer の JSON 変換（yieldなし）----
        string answerJson;
        try
        {
            answerJson = JsonUtility.ToJson(answer);
        }
        catch (Exception ex)
        {
            Debug.LogError($"Answer JSON serialization failed: {ex.Message}");
            yield break;
        }
        Debug.Log($"Sending answer JSON: {answerJson}");

        // ---- EmitAsync 開始だけtryで包む（yieldなし）----
        Task emitTask;
        try
        {
            emitTask = socket.EmitAsync("answer", answerJson);
        }
        catch (Exception ex)
        {
            Debug.LogError($"EmitAsync start exception: {ex.Message}");
            yield break;
        }

        // ---- 完了待ちは try の外で行う（CS1626回避）----
        while (!emitTask.IsCompleted)
        {
            yield return null;
        }

        if (emitTask.IsFaulted)
        {
            Debug.LogError($"Failed to send answer: {emitTask.Exception?.GetBaseException().Message}");
            yield break;
        }

        Debug.Log("Answer sent to signaling server.");
        Debug.Log("❤️ Answerを作成し、サーバーに送信しました。");
    }


    // CS1626対応 + 重複削除済み HandleCandidateAsync
    private IEnumerator HandleCandidateAsync(SocketIOResponse response)
    {
        Debug.Log("❤️ PWAからCandidateを受信しました。");
        if (_peerConnection == null)
        {
            Debug.LogWarning("PeerConnection is not initialized yet. Discarding ICE candidate.");
            yield break;
        }

        bool errorHappened = false;
        try
        {
            var candidateJson = response.GetValue<string>();
            var iceCandidateInit = JsonUtility.FromJson<RTCIceCandidateInit>(candidateJson);

            if (iceCandidateInit != null && !string.IsNullOrEmpty(iceCandidateInit.candidate))
            {
                var rtcIceCandidate = new RTCIceCandidate(iceCandidateInit);
                bool success = _peerConnection.AddIceCandidate(rtcIceCandidate);
                if (!success)
                {
                    Debug.LogError("Failed to add ICE candidate: candidate is invalid.");
                }
            }
            else
            {
                Debug.LogWarning("Received invalid ICE candidate JSON.");
            }
        }
        catch (Exception ex)
        {
            Debug.LogError($"[HandleCandidateAsync] 例外: {ex.Message}\n{ex.StackTrace}");
            errorHappened = true;
        }

        if (errorHappened) yield break;
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

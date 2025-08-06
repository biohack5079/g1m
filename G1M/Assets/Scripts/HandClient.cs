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

// JSONデータを格納するためのクラス
[System.Serializable]
public class Landmark
{
    public float x;
    public float y;
    public float z;
}

// JSONデータ全体をパースするためのヘルパークラス
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
    private bool _isSocketConnecting = false;
    private bool _hasConnectedOnce = false;
    
    public static event Action<List<List<Landmark>>> OnLandmarksReceived;

    void Start()
    {
        InitializeSocketIO();
    }

    void InitializeSocketIO()
    {
        var uri = new Uri(ServerUrl);
        socket = new SocketIOClient.SocketIO(uri, new SocketIOOptions
        {
            EIO = EngineIO.V4,
            Transport = TransportProtocol.WebSocket,
            ConnectionTimeout = new TimeSpan(0, 0, 20)
        });

        socket.OnConnected += (sender, e) =>
        {
            Debug.Log("Socket.IO Connected!");
            _isSocketConnecting = false;
            _hasConnectedOnce = true;
            
            // ★追加: 接続成功時に "hello" メッセージを送信
            SendHelloMessage();

            // WebRTCのシグナリングを開始 (必要に応じてコメントアウトしてSocket.IO接続のみをテスト)
            StartCoroutine(CreateOfferAndSend());
        };

        var configuration = new RTCConfiguration
        {
            iceServers = new RTCIceServer[]
            {
                new RTCIceServer { urls = new string[] { "stun:stun.l.google.com:19302" } }
            }
        };
        _peerConnection = new RTCPeerConnection(ref configuration);
        
        _peerConnection.OnIceCandidate = candidate =>
        {
            if (candidate != null && socket.Connected)
            {
                var candidateObj = new {
                    candidate = candidate.Candidate,
                    sdpMid = candidate.SdpMid,
                    sdpMLineIndex = candidate.SdpMLineIndex
                };
                var candidateJson = JsonUtility.ToJson(candidateObj);
                socket.EmitAsync("candidate", candidateJson);
                Debug.Log("Sent ICE candidate.");
            }
        };

        _peerConnection.OnIceConnectionChange += OnIceConnectionChange;
        _peerConnection.OnConnectionStateChange += OnConnectionStateChange;
        
        // Socket.IO イベントハンドラの設定
        socket.On("offer", response => StartCoroutine(HandleOfferAsync(response)));
        socket.On("answer", response => StartCoroutine(HandleAnswerAsync(response)));
        socket.On("candidate", response => StartCoroutine(HandleCandidateAsync(response)));

        // ★追加: サーバーからの "message" イベントを受信
        socket.On("message", response =>
        {
            string receivedMessage = response.GetValue<string>();
            Debug.Log($"Received message from server: {receivedMessage}");
        });

        socket.OnDisconnected += (sender, e) => 
        {
            Debug.Log("Socket.IO Disconnected! Reason: " + e);
            if (!_isSocketConnecting)
            {
                Debug.Log("Attempting to reconnect...");
                ConnectSocketAsync();
            }
        };
        
        socket.OnError += (sender, e) => Debug.LogError($"Socket.IO Error: {e}");

        _peerConnection.OnDataChannel += channel =>
        {
            _dataChannel = channel;
            Debug.Log("DataChannel received!");
            channel.OnMessage += bytes =>
            {
                string handData = Encoding.UTF8.GetString(bytes);
                
                try
                {
                    var parsedData = JsonUtility.FromJson<HandLandmarksListWrapper>("{\"multiHandLandmarks\":" + handData + "}");
                    if (parsedData != null && parsedData.multiHandLandmarks != null)
                    {
                        OnLandmarksReceived?.Invoke(parsedData.multiHandLandmarks);
                    }
                }
                catch (System.Exception ex)
                {
                    Debug.LogError($"JSON parse error: {ex.Message}");
                    Debug.Log("Received data was: " + handData);
                }
            };
        };
        
        ConnectSocketAsync();
    }

    /// <summary>
    /// サーバーに "hello" メッセージを送信します。
    /// </summary>
    private async void SendHelloMessage()
    {
        if (socket != null && socket.Connected)
        {
            await socket.EmitAsync("message", "Hello from Unity client!");
            Debug.Log("Sent 'Hello from Unity client!' message.");
        }
        else
        {
            Debug.LogWarning("Socket is not connected. Cannot send 'hello' message.");
        }
    }

    private void OnIceConnectionChange(RTCIceConnectionState state)
    {
        Debug.Log($"ICE Connection State changed: {state}");
        if (state == RTCIceConnectionState.Failed || state == RTCIceConnectionState.Disconnected)
        {
            Debug.LogError("ICE connection failed or disconnected. Consider re-establishing connection.");
        }
    }

    private void OnConnectionStateChange(RTCPeerConnectionState state)
    {
        Debug.Log($"Peer Connection State changed: {state}");
        if (state == RTCPeerConnectionState.Failed || state == RTCPeerConnectionState.Disconnected)
        {
            Debug.LogError("Peer connection failed or disconnected. Consider re-establishing connection.");
        }
    }

    private IEnumerator CreateOfferAndSend()
    {
        Debug.Log("Creating offer and sending to Web client...");
        var op = _peerConnection.CreateOffer();
        yield return op;
        if (op.IsError)
        {
            Debug.LogError($"CreateOffer failed: {op.Error.message}");
            yield break;
        }

        var offer = op.Desc;
        var op2 = _peerConnection.SetLocalDescription(ref offer);
        yield return op2;
        if (op2.IsError)
        {
            Debug.LogError($"SetLocalDescription failed: {op2.Error.message}");
            yield break;
        }
        
        var offerJson = JsonUtility.ToJson(offer);
        socket.EmitAsync("offer", offerJson);
        Debug.Log("Sent WebRTC offer.");
    }

    private IEnumerator HandleOfferAsync(SocketIOResponse response)
    {
        Debug.Log("Received an offer from Web client.");
        var offerJson = response.GetValue<string>();
        var sdp = JsonUtility.FromJson<RTCSessionDescription>(offerJson);

        var op1 = _peerConnection.SetRemoteDescription(ref sdp);
        yield return op1;
        if (op1.IsError)
        {
            Debug.LogError($"SetRemoteDescription failed: {op1.Error.message}");
            yield break;
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
        
        var answerJson = JsonUtility.ToJson(answer);
        socket.EmitAsync("answer", answerJson);
        Debug.Log("Sent WebRTC answer.");
    }
    
    private IEnumerator HandleAnswerAsync(SocketIOResponse response)
    {
        Debug.Log("Received an answer from Web client.");
        var answerJson = response.GetValue<string>();
        var sdp = JsonUtility.FromJson<RTCSessionDescription>(answerJson);

        var op1 = _peerConnection.SetRemoteDescription(ref sdp);
        yield return op1;
        if (op1.IsError)
        {
            Debug.LogError($"SetRemoteDescription failed: {op1.Error.message}");
        }
        else
        {
            Debug.Log("Successfully set remote description (answer).");
        }
    }

    private IEnumerator HandleCandidateAsync(SocketIOResponse response)
    {
        Debug.Log("Received an ICE candidate.");
        var candidateJson = response.GetValue<string>();
        
        RTCIceCandidateInit iceCandidateInit = JsonUtility.FromJson<RTCIceCandidateInit>(candidateJson);

        if (iceCandidateInit.candidate != null && !string.IsNullOrEmpty(iceCandidateInit.candidate))
        {
            var rtcIceCandidate = new RTCIceCandidate(iceCandidateInit);
            
            try
            {
                _peerConnection.AddIceCandidate(rtcIceCandidate);
                Debug.Log("Successfully added ICE candidate.");
            }
            catch (System.Exception ex)
            {
                Debug.LogError($"Failed to add ICE candidate due to exception: {ex.Message}");
            }
        }
        else
        {
            Debug.LogWarning("Received invalid ICE candidate JSON or candidate string is empty.");
        }

        yield break;
    }

    private async void ConnectSocketAsync()
    {
        if (_isSocketConnecting) return;
        _isSocketConnecting = true;

        if (_hasConnectedOnce)
        {
            Debug.Log($"Attempting to reconnect to {ServerUrl}...");
            await Task.Delay(2000);
        }
        else
        {
            Debug.Log($"Attempting to connect to {ServerUrl}...");
        }

        try
        {
            await socket.ConnectAsync();
        }
        catch (Exception e)
        {
            Debug.LogError($"Connection failed: {e.GetType().Name} - {e.Message}");
            if (e.InnerException != null)
            {
                Debug.LogError($"Inner Exception: {e.InnerException.Message}");
            }
            _isSocketConnecting = false;
        }
    }
    
    void OnDestroy()
    {
        if (_peerConnection != null)
        {
            _peerConnection.OnIceConnectionChange -= OnIceConnectionChange;
            _peerConnection.OnConnectionStateChange -= OnConnectionStateChange;
            _peerConnection.Close();
            _peerConnection.Dispose();
            _peerConnection = null;
        }
        if (socket != null && socket.Connected)
        {
            socket.DisconnectAsync();
        }
        socket = null;
    }
}

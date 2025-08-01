using UnityEngine;
using UnityEngine.Networking;
using System.Collections;

public class GestureSender : MonoBehaviour
{
    public void SendGesture(string gesture)
    {
        StartCoroutine(PostGesture(gesture));
    }

    IEnumerator PostGesture(string gesture)
    {
        string url = "https://g1m-api.onrender.com/api/gesture";
        string json = "{\"gesture\":\"" + gesture + "\"}";

        UnityWebRequest request = UnityWebRequest.Post(url, json);
        byte[] jsonToSend = new System.Text.UTF8Encoding().GetBytes(json);
        request.uploadHandler = new UploadHandlerRaw(jsonToSend);
        request.downloadHandler = new DownloadHandlerBuffer();
        request.SetRequestHeader("Content-Type", "application/json");

        yield return request.SendWebRequest();

        if (request.result == UnityWebRequest.Result.Success)
            Debug.Log("Gesture sent successfully");
        else
            Debug.LogError("Error sending gesture: " + request.error);
    }
}

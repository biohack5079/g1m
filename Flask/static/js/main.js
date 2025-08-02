async function startCamera() {
  const constraints = {
    video: {
      facingMode: "environment" // 背面カメラ（スマホ用）
    },
    audio: false
  };

  try {
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    const video = document.getElementById("video");
    video.srcObject = stream;
  } catch (err) {
    alert("カメラの使用が許可されていません: " + err);
  }
}

startCamera();

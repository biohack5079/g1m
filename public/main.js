// UnityからのICE Candidateを受信した時の処理 (バッファリング対応)
socket.on('candidate', async (candidate) => {
    console.log('Received ICE candidate from Unity client.');
    console.log('💙 UnityからCandidateを受信しました。');
    if (candidate) {
        let parsedCandidate = typeof candidate === 'string' ? JSON.parse(candidate) : candidate;

        // candidateプロパティを取得（なければparsedCandidate自身を文字列として扱う）
        let sdpCandidate = parsedCandidate.candidate || parsedCandidate;

        // "a=" で始まっていたら先頭2文字を削除
        if (typeof sdpCandidate === 'string' && sdpCandidate.startsWith("a=")) {
            console.log("Trimming 'a=' prefix from candidate string.");
            sdpCandidate = sdpCandidate.substring(2);
        }

        // sdpMidとsdpMLineIndexを補完（欠けていたらデフォルト値を入れる）
        const finalCandidate = {
            candidate: sdpCandidate,
            sdpMid: parsedCandidate.sdpMid !== undefined ? parsedCandidate.sdpMid : '',
            sdpMLineIndex: parsedCandidate.sdpMLineIndex !== undefined ? parsedCandidate.sdpMLineIndex : 0
        };

        if (isDescriptionSet) {
            try {
                await peerConnection.addIceCandidate(new RTCIceCandidate(finalCandidate));
                console.log('ICE candidate added immediately.');
            } catch (e) {
                console.error('Error adding received ICE candidate immediately:', e);
            }
        } else {
            iceCandidateBuffer.push(finalCandidate);
            console.log('ICE candidate buffered.');
        }
    }
});

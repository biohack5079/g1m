from flask import Flask, request, jsonify
from flask_cors import CORS

app = Flask(__name__)
CORS(app)  # Unityからのリクエスト許可

@app.route('/hand', methods=['POST'])
def hand():
    data = request.get_json()
    # TODO: MediaPipe Handsで処理（省略）
    result = {"gesture": "open", "landmarks": [[0.1, 0.2, 0.3], ...]}
    return jsonify(result)

@app.route('/')
def index():
    return "G1m Flask API Ready"

if __name__ == "__main__":
    app.run(debug=True)

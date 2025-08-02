from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
import os

app = Flask(__name__, static_folder="static", static_url_path="")
CORS(app)  # Unityや別ドメインからのリクエスト許可

@app.route('/hand', methods=['POST'])
def hand():
    data = request.get_json()
    print("🖐 Hand Data Received:", data)
    return jsonify({"status": "ok", "echo": data})

@app.route('/')
def serve_index():
    return send_from_directory(app.static_folder, 'index.html')

if __name__ == '__main__':
    app.run(debug=True)

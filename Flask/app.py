from flask import Flask, request, jsonify, render_template
from flask_cors import CORS

app = Flask(__name__, static_folder="static", template_folder="templates")
CORS(app)

@app.route('/')
def index():
    return render_template("index.html")

@app.route('/hand', methods=['POST'])
def hand():
    data = request.get_json()
    # ここでジェスチャーを判定する処理（仮）
    return jsonify({"gesture": "open", "landmarks": data.get("landmarks", [])})

if __name__ == '__main__':
    app.run(debug=True)

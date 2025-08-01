from flask import Flask, request, jsonify

app = Flask(__name__)

@app.route('/apigesture', methods=['POST'])
def handle_gesture():
    data = request.get_json()
    print("Received gesture:", data)
    return jsonify({"status": "ok", "message": "Gesture received", "echo": data})

@app.route('/')
def index():
    return "G1m API Ready"

if __name__ == '__main__':
    app.run(debug=True)

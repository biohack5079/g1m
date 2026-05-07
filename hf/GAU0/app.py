import os
import logging
from fastapi import FastAPI, Request
from llama_cpp import Llama
from huggingface_hub import hf_hub_download
from supabase import create_client
from dotenv import load_dotenv

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

load_dotenv()
app = FastAPI()

# 1. モデルの準備
try:
    model_path = hf_hub_download(
        repo_id="bartowski/Meta-Llama-3.1-8B-Instruct-GGUF",
        filename="Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf"
    )
    llm = Llama(model_path=model_path, n_ctx=1024, n_threads=2, n_gpu_layers=0)
    logger.info("Model loaded successfully.")
except Exception as e:
    logger.error(f"Model load failed: {e}")
    llm = None

# 2. Supabaseの準備
url = os.environ.get("SUPABASE_URL")
key = os.environ.get("SUPABASE_KEY")
supabase = create_client(url, key) if url and key else None

# --- 修正ポイント：あらゆる入力パターンに対応する ---

@app.api_route("/", methods=["GET", "POST"])
@app.api_route("/v1/chat/completions", methods=["POST"])
async def universal_handler(request: Request, prompt: str = None):
    user_prompt = ""

    # 1. GETパラメータから取得 (?prompt=xxx)
    if prompt:
        user_prompt = prompt
    
    # 2. POSTボディから取得
    if request.method == "POST":
        try:
            body = await request.json()
            # ケースA: OpenAI形式 {"messages": [{"role": "user", "content": "..."}]}
            if "messages" in body and isinstance(body["messages"], list):
                user_prompt = body["messages"][-1].get("content", "")
            # ケースB: 単純なJSON {"prompt": "..."}
            elif "prompt" in body:
                user_prompt = body["prompt"]
            # ケースC: Hugging Face等が送るその他の形式
            else:
                user_prompt = str(body)
        except Exception:
            # JSONでない場合はフォームデータなどを試みる
            form = await request.form()
            user_prompt = form.get("prompt", "")

    if not user_prompt:
        return {"response": "プロンプトが空です。?prompt=こんにちは 等を試してください。"}

    if not llm:
        return {"error": "Model not loaded"}

    # 推論
    full_prompt = f"<|begin_of_text|><|start_header_id|>user<|end_header_id|>\n\n{user_prompt}<|eot_id|><|start_header_id|>assistant<|end_header_id|>\n\n"
    
    try:
        output = llm(full_prompt, max_tokens=200, stop=["<|eot_id|>"], echo=False)
        res_text = output["choices"][0]["text"].strip()
        
        # 応答
        return {
            "choices": [{"message": {"content": res_text}}], # OpenAI互換
            "response": res_text # 独自形式
        }
    except Exception as e:
        return {"error": str(e)}

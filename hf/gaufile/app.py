import os
import logging
import asyncio
# pyrefly: ignore [missing-import]
from fastapi import FastAPI, Request
# pyrefly: ignore [missing-import]
from llama_cpp import Llama
# pyrefly: ignore [missing-import]
from huggingface_hub import hf_hub_download
# pyrefly: ignore [missing-import]
from supabase import create_client
# pyrefly: ignore [missing-import]
from dotenv import load_dotenv
# pyrefly: ignore [missing-import]
import socketio

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

load_dotenv()
app = FastAPI()

sio = socketio.AsyncClient()

@sio.event
async def connect():
    logger.info("HF Node connected to Signaling Server")
    await sio.emit('register_role', {'role': 'staff', 'nickname': 'HF Super Node'})

@sio.event
async def distribute_task(data):
    logger.info(f"HF Node received task: {data}")
    # mock processing
    await asyncio.sleep(2)
    await sio.emit('task_result', {'taskId': data.get('taskId'), 'result': 'HFノードで処理完了しました。'})

@app.on_event("startup")
async def startup_event():
    try:
        url = os.environ.get("SIGNALING_URL", "http://localhost:3000")
        await sio.connect(url)
    except Exception as e:
        logger.error(f"Failed to connect to signaling server: {e}")

# 推論の競合を防ぐためのロック
inference_lock = asyncio.Lock()

# 1. モデルの準備
try:
    model_path = hf_hub_download(
        repo_id="bartowski/google_gemma-3-4b-it-GGUF",
        filename="google_gemma-3-4b-it-Q8_0.gguf",
        token=os.environ.get("HF_TOKEN")
    )
    # 修正: n_threadsを環境に合わせて調整（1だと遅すぎてタイムアウトの原因になる）
    # CPUコア数を確認し、控えめに設定
    threads = int(os.cpu_count() or 2) // 2
    threads = max(1, threads)
    llm = Llama(model_path=model_path, n_ctx=1024, n_threads=threads, n_gpu_layers=0)
    logger.info("Model loaded successfully (Optimized for CPU).")
except Exception as e:
    logger.error(f"Model load failed: {e}")
    llm = None

# 2. Supabaseの準備
url = os.environ.get("SUPABASE_URL")
key = os.environ.get("SUPABASE_KEY")
supabase = create_client(url, key) if url and key else None
NODE_ID = "hf_super_node"

# システムプロンプトのキャッシュ（1分間有効）
_prompt_cache = {"content": "You are a helpful assistant.", "expires": 0}

async def get_system_prompt(slug="default"):
    """Supabaseから現在のシステムプロンプトを取得"""
    global _prompt_cache
    import time
    
    # キャッシュが有効ならそれを返す
    if time.time() < _prompt_cache["expires"]:
        return _prompt_cache["content"]

    if not supabase: return _prompt_cache["content"]
    
    try:
        res = supabase.table("system_prompts").select("content").eq("slug", slug).single().execute()
        content = res.data.get("content") if res.data else _prompt_cache["content"]
        # キャッシュを更新
        _prompt_cache = {"content": content, "expires": time.time() + 60}
        return content
    except Exception:
        return _prompt_cache["content"]

async def update_system_prompt(new_content, slug="default"):
    """AIが生成した新しいプロンプトでSupabaseを更新（進化）"""
    if not supabase: return
    try:
        supabase.table("system_prompts").update({"content": new_content}).eq("slug", slug).execute()
        logger.info(f"System prompt evolved: {slug}")
        # 書き込み後はキャッシュを即時無効化して次回の取得で最新を読み込むようにする
        _prompt_cache["expires"] = 0
    except Exception as e:
        logger.error(f"Failed to evolve prompt: {e}")

async def save_chat_to_supabase(sender, content):
    """チャット履歴をSupabaseに保存（Renderノードと同等の永続化）"""
    if not supabase: return
    try:
        # Render側の server.js と同じスキーマで保存
        supabase.table("chat_history").insert({
            "sender_name": f"{sender} ({NODE_ID})",
            "content": content,
            "created_at": "now()" # PostgreSQL側で時間を振る
        }).execute()
    except Exception as e:
        logger.error(f"Failed to record chat from HF Node: {e}")

async def evolve_logic(user_query, ai_response, current_prompt):
    """
    AIに自身の回答を評価させ、システムプロンプトを改善させる
    """
    if not llm: return

    evolution_task = f"""
    Current System Prompt: {current_prompt}
    User Query: {user_query}
    AI Response: {ai_response}
    
    Based on this interaction, improve the System Prompt to be more effective, concise, and helpful. 
    Output ONLY the new system prompt text.
    """
    
    try:
        # 進化ロジックは負荷が高いため、現在はログのみ
        # evolution_prompt = f"<bos><start_of_turn>user\n{evolution_task}<end_of_turn>\n<start_of_turn>model\n"
        # output = llm(evolution_prompt, max_tokens=300, stop=["<end_of_turn>"])
        # new_prompt = output["choices"][0]["text"].strip()
        # if new_prompt and len(new_prompt) > 10:
        #    await update_system_prompt(new_prompt)
        logger.info("Evolution skipped to save resources")
    except Exception as e:
        logger.error(f"Evolution process failed: {e}")

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

    # 1. 現在の進化済みプロンプトを取得
    system_prompt = await get_system_prompt()
    
    # 推論
    full_prompt = f"<bos><start_of_turn>system\n{system_prompt}<end_of_turn>\n<start_of_turn>user\n{user_prompt}<end_of_turn>\n<start_of_turn>model\n"

    # 修正: ロックを使用して一度に1リクエストのみ処理
    async with inference_lock:
        try:
            loop = asyncio.get_event_loop()
            # スレッドプールで推論を実行（非ブロッキング）
            output = await loop.run_in_executor(
                None, 
                lambda: llm(full_prompt, max_tokens=200, stop=["<end_of_turn>"], echo=False)
            )
            # AIの回答をSupabaseに保存（ログとして）
            asyncio.create_task(save_chat_to_supabase("G1:M", output["choices"][0]["text"].strip()))
            res_text = output["choices"][0]["text"].strip()
        except Exception as e:
            logger.error(f"Inference error: {e}")
            return {"error": str(e)}

    # 進化ロジックはロックの外でバックグラウンド実行
    try:
        asyncio.create_task(evolve_logic(user_prompt, res_text, system_prompt))
    except Exception as evolution_err:
        logger.warning(f"Evolution task failed to start: {evolution_err}")

    return {
        "choices": [{"message": {"content": res_text}}],
        "response": res_text
    }

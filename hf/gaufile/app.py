import os
import logging
import asyncio
from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse
import json
from llama_cpp import Llama
from huggingface_hub import hf_hub_download
from supabase import create_client
from dotenv import load_dotenv
# pyrefly: ignore [missing-import]
import socketio

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

load_dotenv()
app = FastAPI()

# 動的に複数のSocket.IOクライアントを管理
active_sio_clients = []

def create_sio_client(url):
    client = socketio.AsyncClient(reconnection=True)
    
    @client.event
    async def connect():
        if llm is None:
            logger.error(f"❌ Model not loaded. Skipping staff registration for {url}.")
            return

        is_remote = "localhost" not in url and "127.0.0.1" not in url
        node_name = "Distributed AI Node" if is_remote else "Local AI Node"
        
        logger.info(f"✅ {node_name} connected to Signaling Server: {url}")
        
        registration_data = {
            'role': 'staff', 
            'nickname': node_name, 
            'anonymousId': 'distributed_pc_worker',
            'pocToken': '【HF Super Node】' if is_remote else '【Local Python Node】'
        }
        await client.emit('register_role', registration_data)

    @client.event
    async def distribute_task(data):
        logger.info(f"📥 Received inference task from {url}: {data}")
        prompt = data.get('prompt') or data.get('payload')
        
        if not llm:
            await client.emit('task_result', {'taskId': data.get('taskId'), 'result': "Model is still initializing..."})
            return
            
        async with inference_lock:
            loop = asyncio.get_event_loop()
            system_prompt = await get_system_prompt()
            base_prompt = system_prompt if len(system_prompt) > 20 else "あなたはG1:Mちゃんです。親しみやすい日本語で回答してください。"
            full_prompt = f"<bos><start_of_turn>system\n{base_prompt}<end_of_turn>\n<start_of_turn>user\n{prompt}<end_of_turn>\n<start_of_turn>model\n"
            
            output = await loop.run_in_executor(None, lambda: llm(full_prompt, max_tokens=200, stop=["<end_of_turn>"], echo=False))
            result_text = output["choices"][0]["text"].strip()

        await client.emit('task_result', {'taskId': data.get('taskId'), 'result': result_text})
        
    return client

@app.on_event("startup")
async def startup_event():
    urls_env = os.environ.get("SIGNALING_URLS", os.environ.get("SIGNALING_URL", "https://dj-g1m.onrender.com"))
    urls = [u.strip() for u in urls_env.split(",") if u.strip()]
    
    for url in urls:
        try:
            client = create_sio_client(url)
            await client.connect(url, transports=['websocket'])
            active_sio_clients.append(client)
        except Exception as e:
            logger.error(f"Failed to connect to signaling server {url}: {e}")

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
    logger.info("🚀 G1:M AI Node is now READY to handle requests.")
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
        return {"status": "loading", "message": "Model is still initializing..."}

    if request.method == "GET" and user_prompt == "health":
        return {"status": "ok", "model": "gemma-3-4b-it"}

    async def response_generator():
        # 1. 現在の進化済みプロンプトを取得
        system_prompt = await get_system_prompt()
        full_prompt = f"<bos><start_of_turn>system\n{system_prompt}<end_of_turn>\n<start_of_turn>user\n{user_prompt}<end_of_turn>\n<start_of_turn>model\n"

        loop = asyncio.get_event_loop()

        async def run_inference():
            async with inference_lock:
                return await loop.run_in_executor(
                    None, 
                    lambda: llm(full_prompt, max_tokens=200, stop=["<end_of_turn>"], echo=False)
                )

        # 推論タスクをバックグラウンドで開始
        task = asyncio.create_task(run_inference())

        # HFルーターの60秒タイムアウト対策: 10秒ごとに空白(スペース)をストリーミング送信して接続を維持
        while not task.done():
            yield b" "
            await asyncio.sleep(10)

        try:
            output = task.result()
            res_text = output["choices"][0]["text"].strip()
            
            # AIの回答をSupabaseに保存（ログとして）
            asyncio.create_task(save_chat_to_supabase("G1:M", res_text))
            
            # 進化ロジックはバックグラウンド実行
            try:
                asyncio.create_task(evolve_logic(user_prompt, res_text, system_prompt))
            except Exception as evolution_err:
                logger.warning(f"Evolution task failed to start: {evolution_err}")

            response_obj = {
                "choices": [{"message": {"content": res_text}}],
                "response": res_text
            }
            yield json.dumps(response_obj).encode("utf-8")
        except Exception as e:
            logger.error(f"Inference error: {e}")
            error_obj = {"error": str(e)}
            yield json.dumps(error_obj).encode("utf-8")

    # StreamingResponseを返し、JSONペイロードの先頭に空白を含めてタイムアウトを回避
    return StreamingResponse(response_generator(), media_type="application/json")

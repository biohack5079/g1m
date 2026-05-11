import os
import logging
import asyncio
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
        repo_id="bartowski/google_gemma-3-4b-it-GGUF",
        filename="google_gemma-3-4b-it-Q8_0.gguf",
        token=os.environ.get("HF_TOKEN")
    )
    # n_threadsを1に制限し、Goプロキシ側のリソースを確保
    # n_ctxも必要最小限に抑える
    llm = Llama(model_path=model_path, n_ctx=1024, n_threads=1, n_gpu_layers=0)
    logger.info("Model loaded successfully (Optimized for CPU).")
except Exception as e:
    logger.error(f"Model load failed: {e}")
    llm = None

# 2. Supabaseの準備
url = os.environ.get("SUPABASE_URL")
key = os.environ.get("SUPABASE_KEY")
supabase = create_client(url, key) if url and key else None

async def get_system_prompt(slug="default"):
    """Supabaseから現在のシステムプロンプトを取得"""
    if not supabase: return "You are a helpful assistant."
    try:
        res = supabase.table("system_prompts").select("content").eq("slug", slug).single().execute()
        return res.data.get("content") if res.data else "You are a helpful assistant."
    except Exception:
        return "You are a helpful assistant."

async def update_system_prompt(new_content, slug="default"):
    """AIが生成した新しいプロンプトでSupabaseを更新（進化）"""
    if not supabase: return
    try:
        supabase.table("system_prompts").update({"content": new_content}).eq("slug", slug).execute()
        logger.info(f"System prompt evolved: {slug}")
    except Exception as e:
        logger.error(f"Failed to evolve prompt: {e}")

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
    
    # スレッドプールで実行してイベントループのブロックを防ぐ
    loop = asyncio.get_event_loop()

    # 推論
    full_prompt = f"<bos><start_of_turn>system\n{system_prompt}<end_of_turn>\n<start_of_turn>user\n{user_prompt}<end_of_turn>\n<start_of_turn>model\n"

    try:
        # スレッドプールで推論を実行（非ブロッキング）
        output = await loop.run_in_executor(
            None, 
            lambda: llm(full_prompt, max_tokens=200, stop=["<end_of_turn>"], echo=False)
        )
        res_text = output["choices"][0]["text"].strip()

        # 進化ロジックはレスポンス後にバックグラウンドで実行
        try:
            asyncio.create_task(evolve_logic(user_prompt, res_text, system_prompt))
        except Exception as evolution_err:
            logger.warning(f"Evolution task failed to start: {evolution_err}")

        return {
            "choices": [{"message": {"content": res_text}}],
            "response": res_text
        }
    except Exception as e:
        logger.error(f"Inference error: {e}")
        return {"error": str(e)}

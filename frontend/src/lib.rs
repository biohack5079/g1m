use wasm_bindgen::prelude::*;
use serde::{Serialize, Deserialize};

#[wasm_bindgen]
pub fn init_panic_hook() {
    #[cfg(feature = "console_error_panic_hook")]
    console_error_panic_hook::set_once();
}

#[derive(Serialize, Deserialize)]
pub struct RobotPose {
    pub l_arm_z: f32,
    pub r_arm_z: f32,
    pub elbow_rot_x: f32,
    pub spine_rot_x: f32,
    pub spine_rot_z: f32,
    pub hips_rot_y: f32,
    pub jump_y: f32,
}

#[wasm_bindgen]
pub fn calculate_procedural_motion(action: &str, progress: f32) -> JsValue {
    let mut pose = RobotPose {
        l_arm_z: -1.2,
        r_arm_z: 1.2,
        elbow_rot_x: 0.0,
        spine_rot_x: 0.0,
        spine_rot_z: 0.0,
        hips_rot_y: 0.0,
        jump_y: 0.0,
    };

    let rhythm = (progress * std::f32::consts::PI * 10.0).sin();

    if action.contains("tora") || action.contains("dance") {
        // リズムに合わせて肘と腕を大きく動かす
        pose.l_arm_z = -1.2 + rhythm * 0.5;
        pose.r_arm_z = 1.2 + rhythm * 0.5;
        pose.elbow_rot_x = rhythm.abs() * 1.8; // 強度を1.5 -> 1.8に向上
        pose.jump_y = rhythm.max(0.0) * 0.5;   // ジャンプ力を 0.3 -> 0.5に向上
        pose.spine_rot_z = rhythm * 0.2;
    }

    serde_wasm_bindgen::to_value(&pose).unwrap()
}

#[derive(Serialize, Deserialize)]
pub struct PerformanceResult {
    pub total_score: i32,
    pub elbow_score: i32,
    pub jump_score: i32,
    pub leg_score: i32,
}

#[wasm_bindgen]
pub fn evaluate_performance(
    total_elbow: f32,
    _total_leg: f32,
    max_jump: f32,
    frame_count: i32,
    moved_elbow: bool,
    moved_jump: bool,
) -> JsValue {
    let elbow_score = if moved_elbow && frame_count > 0 {
        // 平均的な動きがあれば80点以上出るように計算式を緩和
        ((total_elbow / frame_count as f32) * 75.0).min(100.0) as i32
    } else { 0 };

    // ジャンプは 0.1m 以上で検知、0.4m で満点
    let jump_score = if moved_jump { (max_jump * 250.0).min(100.0) as i32 } else { 0 };
    
    // どちらか一方が動いていれば「進歩」とみなす
    let total = if elbow_score > 0 || jump_score > 0 { (elbow_score + jump_score) / 2 } else { 0 };

    let res = PerformanceResult { total_score: total, elbow_score, jump_score, leg_score: 0 };
    serde_wasm_bindgen::to_value(&res).unwrap()
}
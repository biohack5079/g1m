use wasm_bindgen::prelude::*;
use serde::{Serialize, Deserialize};

#[wasm_bindgen]
pub fn init_panic_hook() {
    #[cfg(feature = "console_error_panic_hook")]
    console_error_panic_hook::set_once();
}

#[derive(Serialize, Deserialize)]
pub struct RobotPose {
    pub x: f32,
    pub y: f32,
    pub z: f32,
}

#[wasm_bindgen]
pub fn calculate_procedural_motion(time: f32) -> JsValue {
    let pose = RobotPose { x: time.sin(), y: 0.0, z: time.cos() };
    serde_wasm_bindgen::to_value(&pose).unwrap()
}

#[wasm_bindgen]
pub fn greet(name: &str) -> String {
    format!("G1:M WASM Module: Hello, {}!", name)
}
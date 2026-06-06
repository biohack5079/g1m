package com.g1m.z1m.controller;

import com.g1m.z1m.model.WalletInfo;
import com.g1m.z1m.repository.personal.WalletRepository;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.Base64;
import java.util.HashMap;
import java.util.Map;
import java.time.LocalDateTime;
import java.util.Optional;

/**
 * 投げ銭（カンパ）およびカンパ用Walletの管理を担当するコントローラ。
 */
@RestController
@RequestMapping("/api/kampa")
@CrossOrigin(origins = "*", allowedHeaders = "*", methods = {RequestMethod.GET, RequestMethod.POST, RequestMethod.PUT, RequestMethod.DELETE, RequestMethod.OPTIONS}, maxAge = 3600)
public class KampaController {

    @Autowired
    private WalletRepository walletRepository;

    /**
     * Bot (G1:Mちゃん) のWallet情報を取得する。
     */
    @GetMapping("/wallet/bot")
    public ResponseEntity<?> getBotWallet() {
        try {
            Path[] candidates = {
                Paths.get("/app/z1m/AirWallet/g1-m_chan.jpeg"),
                Paths.get("../../z1m/AirWallet/g1-m_chan.jpeg"),
                Paths.get("z1m/AirWallet/g1-m_chan.jpeg"),
                Paths.get("public/z1m/AirWallet/g1-m_chan.jpeg")
            };
            
            Path imagePath = java.util.Arrays.stream(candidates)
                    .filter(Files::exists)
                    .findFirst()
                    .orElse(null);

            if (imagePath != null) {
                byte[] imageBytes = Files.readAllBytes(imagePath);
                String base64Image = Base64.getEncoder().encodeToString(imageBytes);
                String dataUrl = "data:image/jpeg;base64," + base64Image;

                Map<String, String> response = new HashMap<>();
                response.put("anonymous_id", "g1m");
                response.put("wallet_image_data", dataUrl);
                response.put("wallet_type", "AirWallet");
                response.put("cnc_url", "https://cnc-pwa.onrender.com/?id=g1m");
                return ResponseEntity.ok(response);
            }
            return ResponseEntity.notFound().build();
        } catch (Exception e) {
            return ResponseEntity.internalServerError().body("Error reading bot QR image");
        }
    }

    /**
     * 指定された匿名IDに紐づくWallet情報を取得する。
     */
    @GetMapping("/wallet/{anonymousId}")
    public ResponseEntity<WalletInfo> getWallet(@PathVariable String anonymousId) {
        return walletRepository.findByAnonymousId(anonymousId)
                .map(ResponseEntity::ok)
                .orElse(ResponseEntity.notFound().build());
    }

    /**
     * Wallet情報（QRコード画像データ、HuggingFace URLなど）を登録・更新する。
     */
    @PostMapping("/wallet/register")
    public ResponseEntity<WalletInfo> registerWallet(@RequestBody WalletInfo walletInfo) {
        Optional<WalletInfo> existing = walletRepository.findByAnonymousId(walletInfo.getAnonymousId());
        
        WalletInfo toSave = existing.orElse(new WalletInfo());
        toSave.setAnonymousId(walletInfo.getAnonymousId());
        toSave.setWalletImageData(walletInfo.getWalletImageData());
        toSave.setWalletType(walletInfo.getWalletType());
        toSave.setNickname(walletInfo.getNickname());
        toSave.setCncUrl(walletInfo.getCncUrl());
        toSave.setEmail(walletInfo.getEmail());
        toSave.setNotificationEnabled(walletInfo.isNotificationEnabled());
        toSave.setHuggingFaceUrl(walletInfo.getHuggingFaceUrl());
        toSave.setCreatedAt(LocalDateTime.now().toString());

        return ResponseEntity.ok(walletRepository.save(toSave));
    }

    /**
     * ニックネームのみを更新・保存する。
     */
    @PostMapping("/nickname")
    public ResponseEntity<WalletInfo> updateNickname(@RequestBody NicknameRequest request) {
        WalletInfo wallet = walletRepository.findByAnonymousId(request.getAnonymousId())
                .orElse(new WalletInfo());
        
        wallet.setAnonymousId(request.getAnonymousId());
        wallet.setNickname(request.getNickname());
        if (wallet.getCreatedAt() == null) wallet.setCreatedAt(LocalDateTime.now().toString());
        
        return ResponseEntity.ok(walletRepository.save(wallet));
    }

    /**
     * カンパ（模擬）のメッセージを受け取り、お礼のレスポンスを返す。
     */
    @PostMapping("/donate")
    public ResponseEntity<String> donate(@RequestBody DonationRequest request) {
        // 本来は決済確認などが入るが、PoCではお礼のメッセージを返す。
        String message = String.format("%d円送ったよ、ありがとう！応援よろしく！", request.getAmount());
        return ResponseEntity.ok(message);
    }

    public static class DonationRequest {
        private int amount;
        public int getAmount() { return amount; }
        public void setAmount(int amount) { this.amount = amount; }
    }

    public static class NicknameRequest {
        private String anonymousId;
        private String nickname;
        public String getAnonymousId() { return anonymousId; }
        public String getNickname() { return nickname; }
    }

    /**
     * CORSプリフライトリクエストのためのOPTIONSハンドラ
     */
    @RequestMapping(method = RequestMethod.OPTIONS)
    public ResponseEntity<?> options() {
        return ResponseEntity.ok().build();
    }
}

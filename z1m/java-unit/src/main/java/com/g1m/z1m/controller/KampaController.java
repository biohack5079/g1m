package com.g1m.z1m.controller;

import com.g1m.z1m.model.WalletInfo;
import com.g1m.z1m.repository.WalletRepository;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.time.LocalDateTime;
import java.util.Optional;

/**
 * 投げ銭（カンパ）およびカンパ用Walletの管理を担当するコントローラ。
 */
@RestController
@RequestMapping("/api/kampa")
@CrossOrigin(origins = "*") // PoCのため全許可
public class KampaController {

    @Autowired
    private WalletRepository walletRepository;

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
     * Wallet情報（QRコード画像データなど）を登録・更新する。
     */
    @PostMapping("/wallet/register")
    public ResponseEntity<WalletInfo> registerWallet(@RequestBody WalletInfo walletInfo) {
        Optional<WalletInfo> existing = walletRepository.findByAnonymousId(walletInfo.getAnonymousId());
        
        WalletInfo toSave = existing.orElse(new WalletInfo());
        toSave.setAnonymousId(walletInfo.getAnonymousId());
        toSave.setWalletImageData(walletInfo.getWalletImageData());
        toSave.setWalletType(walletInfo.getWalletType());
        toSave.setCreatedAt(LocalDateTime.now().toString());

        return ResponseEntity.ok(walletRepository.save(toSave));
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
}

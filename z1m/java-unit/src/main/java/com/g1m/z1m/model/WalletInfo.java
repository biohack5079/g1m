package com.g1m.z1m.model;

import jakarta.persistence.*;
import lombok.Data;

@Entity
@Data
public class WalletInfo {
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(unique = true)
    private String anonymousId; // Used for IndexedDB mapping

    @Column(columnDefinition = "TEXT")
    private String walletImageData; // Base64 or path to image
    
    @Column(columnDefinition = "TEXT")
    private String cncQrImage; // CyberNetCall QR Image (Base64)

    private String nickname; // UUIDに紐付いた表示名
    
    private String walletType; // e.g., "AirWallet", "PayPay", "Stripe"
    
    private String cncUrl; // CyberNetCall P2P connection URL
    
    private String email; // For notifications/sign-in
    
    private boolean notificationEnabled; // Notification preference
    
    private String huggingFaceUrl; // HuggingFace model URL
    
    private String createdAt;
}

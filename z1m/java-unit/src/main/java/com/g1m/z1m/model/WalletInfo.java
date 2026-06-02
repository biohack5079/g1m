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

    private String walletImageData; // Base64 or path to image
    
    private String nickname; // UUIDに紐付いた表示名
    
    private String walletType; // e.g., "AirWallet", "PayPay", "Stripe"
    
    private String huggingFaceUrl; // HuggingFace model URL
    
    private String createdAt;
}

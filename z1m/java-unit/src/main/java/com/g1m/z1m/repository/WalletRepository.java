package com.g1m.z1m.repository;

import com.g1m.z1m.model.WalletInfo;
import org.springframework.data.jpa.repository.JpaRepository;
import java.util.Optional;

public interface WalletRepository extends JpaRepository<WalletInfo, Long> {
    Optional<WalletInfo> findByAnonymousId(String anonymousId);
}

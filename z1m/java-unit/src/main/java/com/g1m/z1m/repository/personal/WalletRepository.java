package com.g1m.z1m.repository.personal;

import com.g1m.z1m.model.WalletInfo;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;
import java.util.Optional;

@Repository
public interface WalletRepository extends JpaRepository<WalletInfo, Long> {
    Optional<WalletInfo> findByAnonymousId(String anonymousId);
}
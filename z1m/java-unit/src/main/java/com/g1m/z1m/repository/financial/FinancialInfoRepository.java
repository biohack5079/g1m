package com.g1m.z1m.repository.financial;

import com.g1m.z1m.entity.FinancialInfo;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

@Repository
public interface FinancialInfoRepository extends JpaRepository<FinancialInfo, Long> {
}
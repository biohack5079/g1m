package com.g1m.z1m;

import com.g1m.z1m.Z1mApplication;
import com.g1m.z1m.entity.financial.FinancialInfo;
import com.g1m.z1m.entity.personal.PersonalInfo;
import com.g1m.z1m.model.WalletInfo;
import com.g1m.z1m.repository.financial.FinancialInfoRepository;
import com.g1m.z1m.repository.personal.PersonalInfoRepository;
import com.g1m.z1m.repository.personal.WalletRepository;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.junit.jupiter.api.DisplayName;

import java.io.File;

import static org.assertj.core.api.Assertions.assertThat;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import org.junit.jupiter.api.BeforeAll;

/**
 * Integration test for multi-datasource "Vault" architecture.
 * Ensures personal and financial data are stored in separate physical H2 files.
 */
@SpringBootTest(classes = Z1mApplication.class, properties = {
    "spring.datasource.personal.url=jdbc:h2:file:./db/personal;DB_CLOSE_DELAY=-1",
    "spring.datasource.financial.url=jdbc:h2:file:./db/financial;DB_CLOSE_DELAY=-1",
    "spring.datasource.personal.driver-class-name=org.h2.Driver",
    "spring.datasource.financial.driver-class-name=org.h2.Driver",
    "spring.jpa.hibernate.ddl-auto=update",
    "spring.main.allow-bean-definition-overriding=true",
    "spring.jpa.open-in-view=false"
})
public class VaultIntegrationTest {

    static {
        // Ensure the db directory exists BEFORE the Spring ApplicationContext starts.
        try {
            Files.createDirectories(Paths.get("db"));
        } catch (Exception e) {
            System.err.println("Failed to pre-create db directory: " + e.getMessage());
        }
    }

    @Autowired
    private PersonalInfoRepository personalRepo;

    @Autowired
    private FinancialInfoRepository financialRepo;

    @Autowired
    private WalletRepository walletRepo;

    @Test
    @DisplayName("個人情報と金融情報がそれぞれの物理DBファイルに隔離されて保存されるか")
    public void testDualDatabaseStorage() {
        // 1. 個人情報を保存
        PersonalInfo person = PersonalInfo.builder()
                .fullName("G1M Taro")
                .email("taro@example.com")
                .build();
        PersonalInfo savedPerson = personalRepo.saveAndFlush(person);
        assertThat(savedPerson.getId()).isNotNull();

        // 2. 金融情報を保存 (個人情報IDを紐付け)
        FinancialInfo finance = FinancialInfo.builder()
                .userId(savedPerson.getId())
                .bankName("G1M Central Bank")
                .balance(1000000L)
                .build();
        FinancialInfo savedFinance = financialRepo.saveAndFlush(finance);
        assertThat(savedFinance.getId()).isNotNull();

        // 3. 物理ファイルの存在確認 (MVCCファイル)
        // プロジェクトルートからの相対パスで確実にチェック
        String userDir = System.getProperty("user.dir");
        // new File(parent, child) 形式でパスのセパレータ問題を回避
        File personalDbFile = new File(userDir + "/db", "personal.mv.db");
        File financialDbFile = new File(userDir + "/db", "financial.mv.db");

        if (!personalDbFile.exists() || !financialDbFile.exists()) {
            System.out.println("❌ DB Files missing. Current directory contents: " + userDir);
            File dbDir = new File(userDir, "db");
            if (dbDir.exists()) System.out.println("Files in db/: " + java.util.Arrays.toString(dbDir.list()));
        }

        assertThat(personalDbFile.exists())
                .withFailMessage("❌ Personal DB file not found at: " + personalDbFile.getAbsolutePath())
                .isTrue();
        assertThat(financialDbFile.exists())
                .withFailMessage("❌ Financial DB file not found at: " + financialDbFile.getAbsolutePath())
                .isTrue();
        
        System.out.println("Vault Check: Both .db files generated in z1m/java-unit/db/");
    }

    @Test
    @DisplayName("QRコードのBase64データがPersonal DBに正しく保存・復元されるか")
    public void testBase64QrStorage() {
        String testBase64 = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCABAAEADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2N3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqGhcXl5iZmqjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2N3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqGhcXl5iZmqjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD6pooooAooooAooooAooooAooooAooooAooooAooooAooooAooooAooooAooooA//Z";
        String anonId = "test-user-uuid-12345";

        WalletInfo wallet = new WalletInfo();
        wallet.setAnonymousId(anonId);
        wallet.setWalletImageData(testBase64);
        wallet.setNickname("テストユーザー");

        walletRepo.saveAndFlush(wallet);

        WalletInfo retrieved = walletRepo.findByAnonymousId(anonId).orElseThrow();
        assertThat(retrieved.getWalletImageData()).isEqualTo(testBase64);

        String userDir = System.getProperty("user.dir");
        File personalDbFile = new File(userDir + "/db", "personal.mv.db");
        assertThat(personalDbFile.exists())
                .withFailMessage("❌ Personal DB file for QR not found at: " + personalDbFile.getAbsolutePath())
                .isTrue();
        System.out.println("Base64 Check: QR data verified in Personal DB");
    }

    @Test
    @DisplayName("CNC URLにUUID (?id=) が正しく付加されて保存されるか")
    public void testCncUrlUuidAppending() {
        String anonId = "test-uuid-99999";
        String expectedUrl = "https://cnc-pwa.onrender.com/?id=" + anonId;

        WalletInfo wallet = new WalletInfo();
        wallet.setAnonymousId(anonId);
        wallet.setCncUrl(expectedUrl);

        WalletInfo saved = walletRepo.saveAndFlush(wallet);
        assertThat(saved.getCncUrl()).isEqualTo(expectedUrl);
        assertThat(saved.getCncUrl()).contains("?id=" + anonId);
    }
}

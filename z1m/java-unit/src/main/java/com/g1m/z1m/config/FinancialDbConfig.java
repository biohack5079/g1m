package com.g1m.z1m.config;

import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.autoconfigure.jdbc.DataSourceProperties;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.jdbc.DataSourceBuilder;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.data.jpa.repository.config.EnableJpaRepositories;
import org.springframework.orm.jpa.JpaTransactionManager;
import org.springframework.orm.jpa.LocalContainerEntityManagerFactoryBean;
import org.springframework.orm.jpa.vendor.Database;
import org.springframework.orm.jpa.vendor.HibernateJpaVendorAdapter;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.annotation.EnableTransactionManagement;

import jakarta.persistence.EntityManagerFactory;
import javax.sql.DataSource;
import java.util.HashMap;
import java.util.Map;

@Configuration
@EnableTransactionManagement
@EnableJpaRepositories(
    basePackages = "com.g1m.z1m.repository.financial",
    entityManagerFactoryRef = "financialEntityManagerFactory",
    transactionManagerRef = "financialTransactionManager"
)
public class FinancialDbConfig {

    @Bean(name = "financialDataSourceProperties")
    @ConfigurationProperties("spring.datasource.financial")
    public DataSourceProperties financialDataSourceProperties() {
        return new DataSourceProperties();
    }

    @Bean(name = "financialDataSource")
    public DataSource financialDataSource(@Qualifier("financialDataSourceProperties") DataSourceProperties properties) {
        return properties.initializeDataSourceBuilder().build();
    }

    @Bean(name = "financialEntityManagerFactory")
    public LocalContainerEntityManagerFactoryBean financialEntityManagerFactory(
            @Qualifier("financialDataSource") DataSource dataSource) {
        LocalContainerEntityManagerFactoryBean em = new LocalContainerEntityManagerFactoryBean();
        em.setDataSource(dataSource);
        em.setPackagesToScan("com.g1m.z1m.entity.financial");

        HibernateJpaVendorAdapter vendorAdapter = new HibernateJpaVendorAdapter();
        vendorAdapter.setDatabase(Database.H2);
        vendorAdapter.setDatabasePlatform("org.hibernate.dialect.H2Dialect");
        em.setJpaVendorAdapter(vendorAdapter);

        Map<String, Object> properties = new HashMap<>();
        properties.put("hibernate.hbm2ddl.auto", "update");
        properties.put("hibernate.dialect", "org.hibernate.dialect.H2Dialect");
        em.setJpaPropertyMap(properties);
        em.setPersistenceUnitName("financial");

        return em;
    }

    @Bean(name = "financialTransactionManager")
    public PlatformTransactionManager financialTransactionManager(
            @Qualifier("financialEntityManagerFactory") EntityManagerFactory financialEntityManagerFactory,
            @Qualifier("financialDataSource") DataSource dataSource) {
        JpaTransactionManager txManager = new JpaTransactionManager(financialEntityManagerFactory);
        txManager.setDataSource(dataSource);
        return txManager;
    }
}

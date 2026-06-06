package com.g1m.z1m.config;

import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.autoconfigure.jdbc.DataSourceProperties;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.jdbc.DataSourceBuilder;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Primary;
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
    basePackages = "com.g1m.z1m.repository.personal",
    entityManagerFactoryRef = "personalEntityManagerFactory",
    transactionManagerRef = "personalTransactionManager"
)
public class PersonalDbConfig {

    @Primary
    @Bean(name = "personalDataSourceProperties")
    @ConfigurationProperties("spring.datasource.personal")
    public DataSourceProperties personalDataSourceProperties() {
        return new DataSourceProperties();
    }

    @Primary
    @Bean(name = "personalDataSource")
    public DataSource personalDataSource(@Qualifier("personalDataSourceProperties") DataSourceProperties properties) {
        return properties.initializeDataSourceBuilder().build();
    }

    @Primary
    @Bean(name = "personalEntityManagerFactory")
    public LocalContainerEntityManagerFactoryBean personalEntityManagerFactory(
            @Qualifier("personalDataSource") DataSource dataSource) {
        LocalContainerEntityManagerFactoryBean em = new LocalContainerEntityManagerFactoryBean();
        em.setDataSource(dataSource);
        em.setPackagesToScan("com.g1m.z1m.entity.personal", "com.g1m.z1m.model");

        HibernateJpaVendorAdapter vendorAdapter = new HibernateJpaVendorAdapter();
        vendorAdapter.setDatabase(Database.H2);
        vendorAdapter.setDatabasePlatform("org.hibernate.dialect.H2Dialect");
        em.setJpaVendorAdapter(vendorAdapter);

        Map<String, Object> properties = new HashMap<>();
        properties.put("hibernate.hbm2ddl.auto", "update");
        properties.put("hibernate.dialect", "org.hibernate.dialect.H2Dialect");
        em.setJpaPropertyMap(properties);
        em.setPersistenceUnitName("personal");

        return em;
    }

    @Primary
    @Bean(name = "personalTransactionManager")
    public PlatformTransactionManager personalTransactionManager(
            @Qualifier("personalEntityManagerFactory") EntityManagerFactory personalEntityManagerFactory,
            @Qualifier("personalDataSource") DataSource dataSource) {
        JpaTransactionManager txManager = new JpaTransactionManager(personalEntityManagerFactory);
        txManager.setDataSource(dataSource);
        return txManager;
    }
}

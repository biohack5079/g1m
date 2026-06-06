package com.g1m.z1m.config;

import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.jdbc.DataSourceBuilder;
import org.springframework.boot.orm.jpa.EntityManagerFactoryBuilder;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.data.jpa.repository.config.EnableJpaRepositories;
import org.springframework.orm.jpa.JpaTransactionManager;
import org.springframework.orm.jpa.LocalContainerEntityManagerFactoryBean;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.annotation.EnableTransactionManagement;

import javax.sql.DataSource;
import jakarta.persistence.EntityManagerFactory;

@Configuration
@EnableTransactionManagement
@EnableJpaRepositories(
    basePackages = "com.g1m.z1m.repository.financial",
    entityManagerFactoryRef = "financialEntityManagerFactory",
    transactionManagerRef = "financialTransactionManager"
)
public class FinancialDbConfig {

    @Bean(name = "financialDataSource")
    @ConfigurationProperties(prefix = "spring.datasource.financial")
    public DataSource dataSource() {
        return DataSourceBuilder.create().build();
    }

    @Bean(name = "financialEntityManagerFactory")
    public LocalContainerEntityManagerFactoryBean entityManagerFactory(
            EntityManagerFactoryBuilder builder, @Qualifier("financialDataSource") DataSource dataSource) {
        return builder.dataSource(dataSource).packages("com.g1m.z1m").persistenceUnit("financial").build();
    }

    @Bean(name = "financialTransactionManager")
    public PlatformTransactionManager transactionManager(
            @Qualifier("financialEntityManagerFactory") EntityManagerFactory entityManagerFactory) {
        return new JpaTransactionManager(entityManagerFactory);
    }
}

package com.g1m.z1m.config;

import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.jdbc.DataSourceBuilder;
import org.springframework.boot.orm.jpa.EntityManagerFactoryBuilder;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Primary;
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
    basePackages = "com.g1m.z1m.repository.personal",
    entityManagerFactoryRef = "personalEntityManagerFactory",
    transactionManagerRef = "personalTransactionManager"
)
public class PersonalDbConfig {

    @Primary
    @Bean(name = "personalDataSource")
    @ConfigurationProperties(prefix = "spring.datasource.personal")
    public DataSource dataSource() {
        return DataSourceBuilder.create().build();
    }

    @Primary
    @Bean(name = "personalEntityManagerFactory")
    public LocalContainerEntityManagerFactoryBean entityManagerFactory(
            EntityManagerFactoryBuilder builder, @Qualifier("personalDataSource") DataSource dataSource) {
        return builder.dataSource(dataSource).packages("com.g1m.z1m").persistenceUnit("personal").build();
    }

    @Primary
    @Bean(name = "personalTransactionManager")
    public PlatformTransactionManager transactionManager(
            @Qualifier("personalEntityManagerFactory") EntityManagerFactory entityManagerFactory) {
        return new JpaTransactionManager(entityManagerFactory);
    }
}

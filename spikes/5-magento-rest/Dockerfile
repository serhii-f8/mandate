FROM php:8.3-apache
RUN apt-get update && apt-get install -y --no-install-recommends git unzip libfreetype6-dev libjpeg62-turbo-dev libpng-dev libicu-dev libxml2-dev libxslt1-dev libzip-dev libonig-dev libsodium-dev curl ca-certificates mariadb-client \
 && docker-php-ext-configure gd --with-freetype --with-jpeg \
 && docker-php-ext-install -j4 bcmath gd intl pdo_mysql mysqli soap sockets xsl zip opcache sodium \
 && a2enmod rewrite headers && rm -rf /var/lib/apt/lists/*
COPY --from=composer:2 /usr/bin/composer /usr/local/bin/composer
RUN echo "memory_limit=4G" > /usr/local/etc/php/conf.d/zz-mage.ini && echo "max_execution_time=600" >> /usr/local/etc/php/conf.d/zz-mage.ini
ENV APACHE_DOCUMENT_ROOT=/var/www/html/pub
RUN sed -ri 's#/var/www/html#${APACHE_DOCUMENT_ROOT}#g' /etc/apache2/sites-available/*.conf /etc/apache2/apache2.conf /etc/apache2/conf-available/*.conf
WORKDIR /var/www/html

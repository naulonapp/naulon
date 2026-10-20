server {
    listen 80;
    server_name wp;
    root /var/www/html;
    index index.php;
    __SNIPPET__
    location / { try_files $uri $uri/ /index.php?$args; }
    location ~ \.php$ {
        include fastcgi_params;
        fastcgi_pass wp-fpm:9000;
        fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;
    }
}

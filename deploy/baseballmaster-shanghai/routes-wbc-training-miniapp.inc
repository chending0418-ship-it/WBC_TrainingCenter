location ^~ /wbc/training-miniapp/ {
    client_max_body_size 512k;
    proxy_connect_timeout 3s;
    proxy_read_timeout 15s;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_pass http://127.0.0.1:19310/;
}

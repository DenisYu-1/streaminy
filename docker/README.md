# Docker и запуск SFU видеочата

## Подготовка

1. Поместите TLS сертификаты в `docker/certs`:
   - `fullchain.pem`
   - `privkey.pem`
2. Укажите публичный IP в `docker/coturn.conf` (`external-ip`).
3. Поменяйте `static-auth-secret` и TURN логин/пароль в `docker-compose.yml`.

## Запуск

```bash
docker compose -f docker/docker-compose.yml up -d --build
```

## Что проверить

- Откройте `http://localhost:3000` и зайдите в одну комнату из двух устройств.
- Проверьте: камеры и звук есть у всех участников.
- Нажмите "Поделиться экраном" и убедитесь, что поток появился в блоке "Экран других участников".
- Закройте вкладку участника — его карточка должна исчезнуть у остальных.
- TURN-кандидаты для клиентов выдаются только как `turns:*:443?transport=tcp` и `turns:*:5349?transport=tcp`.

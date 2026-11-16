#!/usr/bin/env sh
# Copy the newest daily snapshot off the box. Run from host cron, e.g.:
#   15 2 * * * /opt/signal/deploy/backup-offsite.sh >> /var/log/signal-backup.log 2>&1
# Requires rclone configured with a remote named "offsite" (B2, S3, Drive …).
set -eu
VOL=$(docker volume inspect -f '{{ .Mountpoint }}' signal_signal-data)
LATEST=$(ls -1 "$VOL/backups"/signal-*.db | sort | tail -n 1)
rclone copy "$LATEST" offsite:nifty-signal-backups/ --immutable
echo "$(date -Iseconds) uploaded $(basename "$LATEST")"

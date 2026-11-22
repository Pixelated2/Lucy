#!/usr/bin/env bash
# Daily backup of the Lucy Locates database (installed as /usr/local/sbin/lucy-locates-backup).
# Optional: set LUCY_BACKUP_BUCKET=gs://your-bucket in /etc/lucy-locates.env to also copy
# each backup to Cloud Storage (the VM's service account needs write access to the bucket).
set -euo pipefail

DB="${LUCY_DB:-/var/lib/lucy-locates/lucy.db}"
DIR=/var/backups/lucy-locates
KEEP_DAYS=30

[[ -f "$DB" ]] || { echo "No database at $DB yet; nothing to back up."; exit 0; }
install -d -m 0750 "$DIR"
OUT="$DIR/lucy-$(date +%Y-%m-%d-%H%M).db"
node --disable-warning=ExperimentalWarning "${LUCY_APP:-/opt/lucy-locates}/deploy/backup-snapshot.mjs" "$DB" "$OUT"
gzip -f "$OUT"
find "$DIR" -name 'lucy-*.db.gz' -mtime +"$KEEP_DAYS" -delete
echo "Backup written: $OUT.gz"

if [[ -n "${LUCY_BACKUP_BUCKET:-}" ]]; then
  if command -v gcloud >/dev/null 2>&1; then
    gcloud storage cp "$OUT.gz" "${LUCY_BACKUP_BUCKET%/}/" --quiet
  elif command -v gsutil >/dev/null 2>&1; then
    gsutil -q cp "$OUT.gz" "${LUCY_BACKUP_BUCKET%/}/"
  else
    echo "LUCY_BACKUP_BUCKET is set but gcloud/gsutil is not installed." >&2; exit 1
  fi
  echo "Copied to $LUCY_BACKUP_BUCKET"
fi

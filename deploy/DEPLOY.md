# Hosting Lucy Locates on a Google Cloud VM

About 15 minutes. You need one Compute Engine VM running **Debian or Ubuntu** (Google's default images are fine). The smallest VM sizes (e2-micro / e2-small) are enough for a lab.

Steps 1–2 are in the Google Cloud console, steps 3–4 are on the VM, and step 5 is on each device.

---

## 1. Open the web ports (console)

1. Go to **Compute Engine → VM instances** and click the VM you're using.
2. Click **Edit**. Under **Firewalls**, tick **Allow HTTP traffic** and **Allow HTTPS traffic**. Click **Save**.

Or from Cloud Shell (replace the VM name and zone):

```bash
gcloud compute instances add-tags YOUR-VM --zone YOUR-ZONE --tags http-server,https-server
```

> If your network doesn't have the standard `default-allow-http` / `default-allow-https` rules, also run:
> `gcloud compute firewall-rules create lucy-allow-web --allow tcp:80,tcp:443 --target-tags http-server,https-server`

## 2. Make the IP address permanent (console)

By default a VM's external IP can change when it's stopped, which would break the app's address.

1. Go to **VPC network → IP addresses**.
2. Find the VM's external address, click **⋮ → Promote to static IP address**, name it `lucy-locates`, and click **Reserve**.

(A static IP that is attached to a running VM has a small cost. Check the console for current pricing.)

## 3. Put the code on the VM

Click **SSH** next to the VM in the console, then:

```bash
sudo apt-get update && sudo apt-get install -y git
git clone -b claude/lucy-locates-inventory-app-pdhcxg https://github.com/pixelated2/lucy.git
cd lucy
```

The repository is private, so git asks for a username and password. Enter your GitHub username, and for the password a **personal access token** (GitHub → Settings → Developer settings → Fine-grained tokens, with read access to this repository). After the branch is merged into `main`, you can drop the `-b …` part.

## 4. Install

Still on the VM, in the `lucy` folder:

```bash
sudo bash deploy/install.sh --access-code CHOOSE-A-CODE
```

When it finishes, it prints your address, for example:

```
Open:  https://34-123-45-67.sslip.io
```

What the script does:
- installs Node.js 22 and **Caddy**, which gets and renews the HTTPS certificate automatically
- runs the app as a background service that starts on boot and restarts if it crashes
- stores the database at `/var/lib/lucy-locates/lucy.db`
- backs it up every night to `/var/backups/lucy-locates`, keeping 30 days

**No domain name?** That's fine. The script uses a free `sslip.io` address built from your IP, and it gets a real HTTPS certificate. If you have a domain, point a DNS **A record** for a name like `lucy.yourlab.org` at the static IP, then run:

```bash
sudo bash deploy/install.sh --domain lucy.yourlab.org
```

**Access code:** optional, but recommended because the address is reachable from the internet. Without one, anyone who has the link can open the app. To change it later, edit `LUCY_ACCESS_CODE=` in `/etc/lucy-locates.env`, then run `sudo systemctl restart lucy-locates`.

## 5. Set up each device

Open the address on the device, enter your name, and if you set one, enter the access code under **Settings → Sync**. Then install it:

| Device | How to install |
|---|---|
| Android | Chrome → ⋮ → **Install app** |
| iPhone / iPad | Safari → Share → **Add to Home Screen** |
| Windows | Edge or Chrome → install icon in the address bar |
| Chromebook | Chrome → install icon in the address bar |

---

## Everyday admin

| Task | Command (on the VM) |
|---|---|
| Update to the newest code | `cd ~/lucy && git pull && sudo bash deploy/install.sh` |
| Is it running? | `sudo systemctl status lucy-locates` |
| Live log | `sudo journalctl -u lucy-locates -f` |
| HTTPS / web server log | `sudo journalctl -u caddy -f` |
| Back up now | `sudo systemctl start lucy-locates-backup` |
| List backups | `ls -lh /var/backups/lucy-locates` |

Running the install script again is always safe. It keeps your database, address and access code.

### Restore a backup

```bash
sudo systemctl stop lucy-locates
gunzip -c /var/backups/lucy-locates/lucy-YYYY-MM-DD-HHMM.db.gz | sudo tee /var/lib/lucy-locates/lucy.db >/dev/null
sudo rm -f /var/lib/lucy-locates/lucy.db-wal /var/lib/lucy-locates/lucy.db-shm
sudo chown lucy:lucy /var/lib/lucy-locates/lucy.db
sudo systemctl start lucy-locates
```

Devices pick up the restored data on their next sync.

### Off-server backups (recommended)

Backups on the same disk don't protect you if the VM is lost. To also copy each nightly backup to Cloud Storage:

1. Create a bucket: **Cloud Storage → Buckets → Create**, for example `yourlab-lucy-backups`.
2. Give the VM's service account write access to it (bucket → **Permissions → Grant access** → the VM's service account → **Storage Object Creator**). The VM's *Cloud API access scopes* must allow Storage write. You can check this under VM → Edit → Access scopes.
3. Run `echo 'LUCY_BACKUP_BUCKET=gs://yourlab-lucy-backups' | sudo tee -a /etc/lucy-locates.env`, then test with `sudo systemctl start lucy-locates-backup && sudo journalctl -u lucy-locates-backup -n 5`.

You can also turn on scheduled **disk snapshots** for the VM (Compute Engine → Snapshots → Create snapshot schedule).

### Troubleshooting

- **Browser can't connect:** check that step 1 (firewall) is done and that `sudo systemctl status caddy` shows *active*.
- **Certificate error on first visit:** wait a minute and reload. If it continues, check `sudo journalctl -u caddy -n 50`. The usual causes are ports 80/443 still being closed, or a domain that doesn't point at this IP yet.
- **"Access code" shown in the app's top bar:** the code entered on that device doesn't match `/etc/lucy-locates.env`.
- **Camera won't open:** the app must be opened through the `https://` address.

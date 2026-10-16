#!/bin/bash
# Dead-man revert for the bosbackup sshd change (phase E step E5a; a copy of Wall Game's
# wgbackup-sshd-revert.sh). Armed with systemd-run --on-active=10min before the sshd reload,
# and stopped once a NEW admin login works. If it fires, it restores the AllowUsers drop-in
# saved before the change, removes the bosbackup Match drop-in, and reloads sshd only if
# the restored config is valid.
set -u
logger -t bosbackup-sshd-revert "revert starting"
cp -p /var/backups/00-wallgame-hardening.conf.pre-bosbackup /etc/ssh/sshd_config.d/00-wallgame-hardening.conf
rm -f /etc/ssh/sshd_config.d/14-bos-backup.conf
if sshd -t; then
  systemctl reload ssh.service
  logger -t bosbackup-sshd-revert "revert done, ssh reloaded"
else
  logger -t bosbackup-sshd-revert "revert: restored config invalid, NOT reloaded"
fi

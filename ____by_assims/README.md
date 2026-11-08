# Remote QEMU VM Manager

This app runs real x86 virtual machines with QEMU/KVM in a Linux Codespace and displays them in the browser with noVNC. The iPad only needs a browser; the Codespace provides the VM CPU, memory, and storage.

## Start

The Codespace needs `/dev/kvm`, QEMU, `qemu-img`, Node.js 20 or newer, and passwordless `sudo` access to `/usr/bin/qemu-system-x86_64`. In the supplied Ubuntu 24.04 Codespace, install the host packages with:

```sh
sudo apt-get update
sudo apt-get install -y qemu-system-x86 qemu-utils
npm install
npm start
```

Forward port `8002` from the VS Code Ports panel and keep it **Private**. Open the forwarded HTTPS URL on the iPad. The same port serves the manager, VM API, and VNC WebSocket; no separate VNC port is exposed.

## Virtual machines

- VM profiles, names, and memory settings are stored in `vm-data/vms.json`.
- Each VM gets a sparse 24 GB QCOW2 system disk in `vm-data/<id>/system.qcow2`.
- ISO and IMG uploads are stored in that VM's data directory. Uploads are limited to 10 GB.
- Only one VM runs at a time; starting another VM stops the current one.
- The bundled Linux Live ISO is a small boot-test image. Bring your own OS installer for a usable guest system.
- QEMU provides standard BIOS and virtual hardware. OS compatibility varies by installer and guest requirements. Windows 11 may require UEFI, Secure Boot, and TPM settings that are not configured here; no all-version compatibility guarantee is made.

Keep the forwarded port private: this development server is intended for a single-user Codespace and does not provide application-level sign-in.
SESAME ROBOT EMULATOR — LICENCES AND ATTRIBUTION
================================================================================

Sesame Robot Emulator is a teaching emulator. It runs the real Sesame robot
firmware on an emulated ESP32 and draws what that firmware does. It is not a
robot, and it is never a measurement of one — the application says so on its
own front panel, and this folder is the other half of that honesty: it tells
you exactly whose software is inside it and under what terms.

Everything named here is installed with the application, in the folder this file
is in. You do not need the internet, a source checkout, or any account to read
any of it.


1. SESAME ROBOT EMULATOR ITSELF — Apache License 2.0
--------------------------------------------------------------------------------
    Sesame-Robot-Emulator-LICENSE-Apache-2.0.txt
                            the licence
    Sesame-Robot-Emulator-NOTICE.txt
                            attribution, and the list of files derived from the
                            upstream Sesame Robot Project (Apache-2.0), which
                            Sesame Robot Emulator modified and says so

    Published by Echo Zed Labs — https://echozed.com, contact@echozed.com
    Source: https://github.com/echozulucode/sesame-robot-emulator

2. QEMU — GNU General Public License, version 2   *** BUNDLED BINARY ***
--------------------------------------------------------------------------------
    QEMU-GPL-2.0.txt        the GPL-2.0 text. The Espressif Windows archive this
                            binary came from contains no licence file at all, so
                            this copy is the one you get.
    QEMU-LICENSE.txt        QEMU's own LICENSE from the exact tag shipped
                            (esp-develop-9.2.2-20260417). It explains which
                            parts are BSD/MIT and that the firmware blobs are
                            separate programs.
    QEMU-SOURCE-OFFER.txt   the written offer of source code required by
                            GPL-2.0 section 3(b), valid for three years.

    The binary is <install folder>\qemu\bin\qemu-system-xtensa.exe.
    Sesame Robot Emulator runs it as a separate process and talks to it over a
    socket; it does not link against it.

3. THE FIRMWARE IMAGE — mixed, and part of it is LGPL-2.1-or-later
--------------------------------------------------------------------------------
    LGPL-2.1.txt                the LGPL-2.1 text
    FIRMWARE-LGPL-RELINK.txt    what is statically linked into
                                images\distro-v1-esp32-cli-oled.flash.bin, and
                                the complete, pinned, scripted path to
                                rebuilding it against your own copy of those
                                libraries — which is what LGPL-2.1 section 6
                                asks for

4. EVERYTHING ELSE
--------------------------------------------------------------------------------
    THIRD-PARTY-NOTICES.md      every third-party component, in three
                                categories: committed, fetched at build time,
                                and bundled here. The web interface is React,
                                three.js and friends, all MIT; the desktop shell
                                is Tauri and Rust crates, MIT / Apache-2.0.

    One open question is recorded honestly rather than answered: the four ESP32
    boot ROM images under qemu\share\qemu\ are Espressif silicon dumps that
    Espressif publishes with its own QEMU release and states no terms for.
    THIRD-PARTY-NOTICES.md section C2 says so plainly.


IF YOU ARE INSTALLING THIS FOR A CHILD
--------------------------------------------------------------------------------
Nothing here asks anything of you. There is no account and no sign-in, and
Sesame Robot Emulator makes no network connection of its own: the only socket
it opens is a loopback one to the emulator running on the same machine, and its
content-security policy refuses every remote address outright. The emulator and
the firmware are already inside the installer, which is why it is large, and
the application works with the network switched off.

One honest caveat, because "no network" is the kind of claim that should be
exact: the window itself is drawn by Microsoft's WebView2 runtime, which is
part of Windows and not part of this application, and Windows was observed
making its own connections to Microsoft while the app was open. That is Windows
doing what Windows does. Nothing in Sesame Robot Emulator asks it to, and
nothing from Sesame Robot Emulator is sent anywhere.

Windows will probably warn you that this application is from an unknown
publisher, because it is not code-signed. That warning is about a signature, not
about behaviour. If you would rather not click past it, do not — nothing here is
worth overriding your own judgement for.

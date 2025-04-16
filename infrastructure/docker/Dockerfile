# -----------------------------------------------------------------------------
# Bytebot Dockerfile - Virtual Desktop Environment
# -----------------------------------------------------------------------------

# Base image
FROM ubuntu:22.04

# -----------------------------------------------------------------------------
# 1. Environment setup
# -----------------------------------------------------------------------------
# Set non-interactive installation
ARG DEBIAN_FRONTEND=noninteractive
# Configure display for X11 applications
ENV DISPLAY=:0

# -----------------------------------------------------------------------------
# 2. System dependencies installation
# -----------------------------------------------------------------------------
RUN apt-get update && apt-get install -y \
    # X11 / VNC
    xvfb x11vnc xauth x11-xserver-utils \
    x11-apps sudo software-properties-common \
    # Desktop environment 
    xfce4 xfce4-goodies dbus \
    # Display manager with autologin capability
    lightdm \
    # Development tools
    python3 python3-pip curl wget git vim \
    # Utilities
    supervisor netcat-openbsd \
    # Applications
    xpdf gedit xpaint \
    # Libraries
    libxtst-dev \
    # Remove unneeded dependencies
    && apt-get remove -y light-locker xfce4-screensaver xfce4-power-manager || true \
    # Clean up to reduce image size
    && apt-get clean && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /run/dbus && \
    # Generate a machine-id so dbus-daemon doesn't complain
    dbus-uuidgen --ensure=/etc/machine-id

# -----------------------------------------------------------------------------
# 3. Additional software installation
# -----------------------------------------------------------------------------
# Install Firefox
RUN apt-get update && apt-get install -y \
    # Install necessary for adding PPA
    software-properties-common apt-transport-https wget gnupg \
    # Install Additional Graphics Libraries
    mesa-utils \
    libgl1-mesa-dri \
    libgl1-mesa-glx \
    # Install Sandbox Capabilities
    libcap2-bin \
    # Install Fonts
    fontconfig \
    fonts-dejavu \
    fonts-liberation \
    fonts-freefont-ttf \
    && add-apt-repository -y ppa:mozillateam/ppa \
    && apt-get update \
    && apt-get install -y firefox-esr \
    && apt-get clean && rm -rf /var/lib/apt/lists/* \
    # Set Firefox as default browser system-wide
    && update-alternatives --install /usr/bin/x-www-browser x-www-browser /usr/bin/firefox-esr 200 \
    && update-alternatives --set x-www-browser /usr/bin/firefox-esr \
    # Configure default MIME handlers for web content
    && mkdir -p /etc/xdg/xfce4/helpers \
    && echo '[Desktop Entry]' > /etc/xdg/xfce4/helpers/firefox.desktop \
    && echo 'Version=1.0' >> /etc/xdg/xfce4/helpers/firefox.desktop \
    && echo 'Type=X-XFCE-Helper' >> /etc/xdg/xfce4/helpers/firefox.desktop \
    && echo 'Name=Firefox Web Browser' >> /etc/xdg/xfce4/helpers/firefox.desktop \
    && echo 'X-XFCE-Binaries=firefox-esr;firefox;' >> /etc/xdg/xfce4/helpers/firefox.desktop \
    && echo 'X-XFCE-Category=WebBrowser' >> /etc/xdg/xfce4/helpers/firefox.desktop \
    && echo 'X-XFCE-Commands=%B;%B' >> /etc/xdg/xfce4/helpers/firefox.desktop \
    && echo 'X-XFCE-CommandsWithParameter=%B %s;%B %s;' >> /etc/xdg/xfce4/helpers/firefox.desktop \
    && echo 'WebBrowser=firefox-esr' > /etc/xdg/xfce4/helpers.rc \
    && fc-cache -f -v

# Install Node.js
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get update \
    && apt-get install -y nodejs \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Upgrade pip
RUN pip3 install --upgrade pip

# -----------------------------------------------------------------------------
# 4. VNC and remote access setup
# -----------------------------------------------------------------------------
# Install noVNC and websockify
RUN git clone https://github.com/novnc/noVNC.git /opt/noVNC \
    && git clone https://github.com/novnc/websockify.git /opt/websockify \
    && cd /opt/websockify \
    && pip3 install --break-system-packages .

# -----------------------------------------------------------------------------
# 5. Application setup (bytebotd)
# -----------------------------------------------------------------------------
# Copy package files first to leverage Docker cache

# Install dependencies required to build libnut-core
RUN apt-get update && \
    apt-get install -y cmake libx11-dev libxtst-dev libxinerama-dev libxi-dev libxrandr-dev git build-essential && \
    rm -rf /var/lib/apt/lists/*


COPY ./packages/bytebotd/ /bytebotd/
WORKDIR /bytebotd
RUN npm install --build-from-source

RUN npm run build 

WORKDIR /compile

RUN git clone https://github.com/ZachJW34/libnut-core.git && \
    cd libnut-core && \
    npm install && \
    npm run build:release

# replace /bytebotd/node_modules/@nut-tree-fork/libnut-linux/build/Release/libnut.node with /compile/libnut-core/build/Release/libnut.node
RUN rm -f /bytebotd/node_modules/@nut-tree-fork/libnut-linux/build/Release/libnut.node && \
    cp /compile/libnut-core/build/Release/libnut.node /bytebotd/node_modules/@nut-tree-fork/libnut-linux/build/Release/libnut.node

RUN rm -rf /compile

WORKDIR /bytebotd

# -----------------------------------------------------------------------------
# 6. System configuration
# -----------------------------------------------------------------------------
# Add Supervisor Configuration for service management
COPY ./infrastructure/docker/supervisord.conf /etc/supervisor/conf.d/supervisord.conf

# Set restrictive permissions on supervisord configuration
RUN chmod 644 /etc/supervisor/conf.d/supervisord.conf && \
    chown root:root /etc/supervisor/conf.d/supervisord.conf

# Set restrictive permissions on bytebotd directory
RUN chown -R root:root /bytebotd && \
    chmod -R 755 /bytebotd

# -----------------------------------------------------------------------------
# 7. User setup and autologin configuration
# -----------------------------------------------------------------------------
# Create non-root user
RUN useradd -ms /bin/bash bytebot && echo "bytebot ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers

RUN chmod 755 /var/run/dbus && \
    chown bytebot:bytebot /var/run/dbus

RUN mkdir -p /tmp/bytebot-screenshots && \
    chown -R bytebot:bytebot /tmp/bytebot-screenshots

# Configure autologin for the bytebot user
RUN mkdir -p /etc/lightdm/lightdm.conf.d && \
    echo '[Seat:*]' > /etc/lightdm/lightdm.conf.d/50-autologin.conf && \
    echo 'autologin-user=bytebot' >> /etc/lightdm/lightdm.conf.d/50-autologin.conf && \
    echo 'autologin-user-timeout=0' >> /etc/lightdm/lightdm.conf.d/50-autologin.conf && \
    echo 'autologin-session=xfce' >> /etc/lightdm/lightdm.conf.d/50-autologin.conf

# Make sure the lightdm configuration has proper permissions
RUN chmod 644 /etc/lightdm/lightdm.conf.d/50-autologin.conf && \
    chown root:root /etc/lightdm/lightdm.conf.d/50-autologin.conf

# Set custom desktop background
# Create backgrounds directory
RUN mkdir -p /usr/share/backgrounds/bytebot

# Copy background.jpg from the build context
COPY ./static/background.jpg /usr/share/backgrounds/bytebot/ 
RUN chmod 644 /usr/share/backgrounds/bytebot/background.jpg

# Add XFCE configuration files
COPY ./infrastructure/docker/xfce4/ /tmp/xfce4/

# Set up XFCE configuration
RUN mkdir -p /home/bytebot/.config/xfce4/ && \
    mkdir -p /home/bytebot/Desktop && \
    # Copy the XFCE configuration files
    cp -r /tmp/xfce4/* /home/bytebot/.config/xfce4/ && \
    # Create .xsessionrc file for the user to ensure XFCE starts properly
    mkdir -p /home/bytebot/.config && \
    echo "exec startxfce4" > /home/bytebot/.xsessionrc && \
    # Ensure all settings are owned by the user
    chown -R bytebot:bytebot /home/bytebot/.config /home/bytebot/Desktop /home/bytebot/.xsessionrc

# Replace default Web Browser shortcut with Firefox
RUN mkdir -p /etc/skel/.config/xfce4/panel/launcher-* && \
    mkdir -p /usr/share/applications/ && \
    echo '[Desktop Entry]' > /usr/share/applications/firefox.desktop && \
    echo 'Version=1.0' >> /usr/share/applications/firefox.desktop && \
    echo 'Type=Application' >> /usr/share/applications/firefox.desktop && \
    echo 'Name=Firefox Web Browser' >> /usr/share/applications/firefox.desktop && \
    echo 'Comment=Browse the web with Firefox' >> /usr/share/applications/firefox.desktop && \
    echo 'Exec=/usr/bin/firefox-esr %U' >> /usr/share/applications/firefox.desktop && \
    echo 'Icon=firefox-esr' >> /usr/share/applications/firefox.desktop && \
    echo 'Path=' >> /usr/share/applications/firefox.desktop && \
    echo 'Terminal=false' >> /usr/share/applications/firefox.desktop && \
    echo 'StartupNotify=true' >> /usr/share/applications/firefox.desktop && \
    echo 'Categories=Network;WebBrowser;' >> /usr/share/applications/firefox.desktop && \
    chmod +x /usr/share/applications/firefox.desktop && \
    # Copy Firefox desktop file to panel configuration
    mkdir -p /home/bytebot/.config/xfce4/panel && \
    cp -f /usr/share/applications/firefox.desktop /home/bytebot/.config/xfce4/panel/ && \
    # Create a backup of the default XFCE panel configuration
    mkdir -p /etc/xdg/xfce4/panel/backup && \
    # Also add Firefox to desktop
    mkdir -p /home/bytebot/Desktop && \
    cp -f /usr/share/applications/firefox.desktop /home/bytebot/Desktop/ && \
    chown -R bytebot:bytebot /home/bytebot/.config/xfce4/panel /home/bytebot/Desktop

# Add a desktop shortcut for the Terminal
RUN echo '[Desktop Entry]' > /usr/share/applications/terminal.desktop && \
    echo 'Version=1.0' >> /usr/share/applications/terminal.desktop && \
    echo 'Type=Application' >> /usr/share/applications/terminal.desktop && \
    echo 'Name=Terminal Emulator' >> /usr/share/applications/terminal.desktop && \
    echo 'Comment=Open a terminal' >> /usr/share/applications/terminal.desktop && \
    echo 'Exec=exo-open --launch TerminalEmulator' >> /usr/share/applications/terminal.desktop && \
    echo 'Icon=org.xfce.terminalemulator' >> /usr/share/applications/terminal.desktop && \
    echo 'Path=' >> /usr/share/applications/terminal.desktop && \
    echo 'Terminal=false' >> /usr/share/applications/terminal.desktop && \
    echo 'StartupNotify=true' >> /usr/share/applications/terminal.desktop && \
    echo 'Categories=Utility;TerminalEmulator;' >> /usr/share/applications/terminal.desktop && \
    chmod +x /usr/share/applications/terminal.desktop && \
    mkdir -p /home/bytebot/Desktop && \
    cp -f /usr/share/applications/terminal.desktop /home/bytebot/Desktop/ && \
    chown -R bytebot:bytebot /home/bytebot/Desktop

USER bytebot
WORKDIR /home/bytebot

# -----------------------------------------------------------------------------
# 8. Port configuration and runtime
# -----------------------------------------------------------------------------
# - Port 9990: bytebotd
# - Port 5900: VNC display for the Ubuntu VM
# - Port 6080: noVNC client
# - Port 6081: noVNC HTTP proxy
EXPOSE 9990 5900 6080 6081

# Start supervisor to manage all services
CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/conf.d/supervisord.conf", "-n"]
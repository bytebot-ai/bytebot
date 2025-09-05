# Extend the pre-built bytebot-desktop image
FROM ghcr.io/bytebot-ai/bytebot-desktop:edge

# Add additional packages, applications, or customizations here

# Expose the bytebotd service port
EXPOSE 9990

# Create non-root user
RUN groupadd -g 1000 bytebot && \
    useradd -u 1000 -g bytebot -m -s /bin/bash bytebot

# Start the bytebotd service

# Create non-root user
RUN useradd -m -u 1000 -s /bin/bash bytebot

# Switch to non-root user
USER bytebot


# Create non-root user for security
RUN useradd -m -u 1001 -s /bin/bash bytebot

# Set appropriate permissions for application directories
# Adjust the path below based on your application's working directory
RUN if [ -d /app ]; then chown -R bytebot:bytebot /app; fi

# Switch to non-root user
USER bytebot

CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/conf.d/supervisord.conf", "-n"]

# Switch to non-root user
USER bytebot

FROM nginx:alpine

# Copy built static files
COPY dist/ /usr/share/nginx/html/
COPY nginx.conf /etc/nginx/conf.d/default.conf

# HuggingFace Spaces exposes port 7860
EXPOSE 7860

CMD ["nginx", "-g", "daemon off;"]

FROM python:3.11-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc g++ curl gfortran make \
    r-base \
    libcurl4-openssl-dev libssl-dev libxml2-dev \
    liblapack-dev libblas-dev \
    libuv1-dev \
    && rm -rf /var/lib/apt/lists/*

RUN Rscript -e "install.packages('BiocManager', repos='https://cran.rstudio.com/')"
RUN Rscript -e "BiocManager::install(c('preprocessCore', 'impute', 'limma'), ask=FALSE, update=FALSE)"
RUN Rscript -e "install.packages(c('WGCNA', 'dynamicTreeCut', 'jsonlite', 'matrixStats', 'foreach', 'doParallel', 'fastcluster', 'pheatmap', 'plotly', 'htmlwidgets', 'RColorBrewer', 'gplots'), repos='https://cran.rstudio.com/'); pkgs <- c('WGCNA','dynamicTreeCut','jsonlite','matrixStats','foreach','doParallel','fastcluster','pheatmap','plotly','htmlwidgets','RColorBrewer','gplots'); missing <- pkgs[!sapply(pkgs, requireNamespace, quietly=TRUE)]; if (length(missing)) stop(paste('Failed to install:', paste(missing, collapse=', ')))"

COPY backend/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt

COPY backend /app/backend
COPY frontend /app/frontend
COPY proteomics_ai /app/proteomics_ai
COPY app_loader.py /app/app_loader.py
COPY main.py /app/main.py

RUN mkdir -p /data/uploads /data/runs /data/exports /data/scratch

ENV DATA_DIR=/data

EXPOSE 8000
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]

# PostgreSQL 16 + pgvector + PGroonga
# 基础镜像只带 pgvector；中文友好全文检索需要 PGroonga（groonga.org apt 源）。
# 注意：本镜像的 PostgreSQL 来自 PGDG，对应包名是 postgresql-16-pgdg-pgroonga。
FROM pgvector/pgvector:pg16

RUN apt-get update \
  && apt-get install -y --no-install-recommends wget ca-certificates \
  && wget -q https://packages.groonga.org/debian/groonga-apt-source-latest-bookworm.deb -O /tmp/groonga-apt-source.deb \
  && apt-get install -y --no-install-recommends /tmp/groonga-apt-source.deb \
  && rm -f /tmp/groonga-apt-source.deb \
  && apt-get update \
  && apt-get install -y --no-install-recommends postgresql-16-pgdg-pgroonga \
  && rm -rf /var/lib/apt/lists/*

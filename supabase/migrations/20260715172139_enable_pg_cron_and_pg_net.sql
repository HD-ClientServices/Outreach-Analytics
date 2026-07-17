-- OJO: tras crear pg_net por primera vez, el background worker no procesa la cola
-- hasta correr `select net.worker_restart();` una vez. Sintoma: net.http_request_queue
-- acumula filas y net._http_response queda vacio.
create extension if not exists pg_cron;
create extension if not exists pg_net;

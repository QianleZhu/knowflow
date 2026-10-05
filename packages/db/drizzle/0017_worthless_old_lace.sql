CREATE INDEX "upload_contents_document_idx" ON "document_upload_contents" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "upload_requests_document_idx" ON "document_upload_requests" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "files_hash_idx" ON "files" USING btree ("hash");
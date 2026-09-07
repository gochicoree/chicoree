// Package s3 stores blobs in an S3-compatible bucket (AWS S3, MinIO, Ceph
// RGW, Cloudflare R2, …). Selected with STORAGE_DRIVER=s3.
package s3

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	awss3 "github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"

	"registryd/internal/storage"
)

func init() {
	storage.Register(&storage.Plugin{
		Name:        "s3",
		Description: "Any S3-compatible object store.",
		Options: []storage.OptionDoc{
			{Key: "BUCKET", Description: "Bucket name", Required: true},
			{Key: "REGION", Description: "Region", Default: "us-east-1"},
			{Key: "ENDPOINT", Description: "Custom endpoint URL (MinIO, R2, …); empty for AWS"},
			{Key: "ACCESS_KEY", Description: "Access key id; empty uses the AWS default credential chain"},
			{Key: "SECRET_KEY", Description: "Secret access key"},
			{Key: "FORCE_PATH_STYLE", Description: "Path-style addressing (needed by MinIO)", Default: "true"},
			{Key: "REDIRECT_GET", Description: "Serve blob GETs via presigned URLs", Default: "false"},
			{Key: "PRESIGN_EXPIRY", Description: "Presigned URL lifetime", Default: "20m"},
		},
		New: func(ctx context.Context, o storage.Options) (storage.Driver, error) {
			return New(ctx, Options{
				Endpoint:       storage.Get(o, "ENDPOINT", ""),
				Region:         storage.Get(o, "REGION", "us-east-1"),
				Bucket:         storage.Get(o, "BUCKET", ""),
				AccessKey:      storage.Get(o, "ACCESS_KEY", ""),
				SecretKey:      storage.Get(o, "SECRET_KEY", ""),
				ForcePathStyle: storage.GetBool(o, "FORCE_PATH_STYLE", true),
				RedirectGET:    storage.GetBool(o, "REDIRECT_GET", false),
				PresignExpiry:  storage.GetDuration(o, "PRESIGN_EXPIRY", 20*time.Minute),
			})
		},
	})
}

// Options configures the S3 driver.
type Options struct {
	Endpoint       string
	Region         string
	Bucket         string
	AccessKey      string
	SecretKey      string
	ForcePathStyle bool
	RedirectGET    bool
	PresignExpiry  time.Duration
}

// Driver stores blobs as objects in a bucket. Bodies up to partSize go in
// one PutObject; larger ones are sent as a multipart upload with parts
// buffered in memory, which keeps every request body seekable (SigV4 signs
// the payload over plain HTTP) and lets an object of any size be abandoned
// before it becomes visible — a reader that fails at the end (digest
// mismatch) aborts the multipart upload and leaves nothing behind.
type Driver struct {
	client  *awss3.Client
	presign *awss3.PresignClient
	opts    Options
}

// New builds the client and verifies the bucket is reachable.
func New(ctx context.Context, opts Options) (*Driver, error) {
	if opts.PresignExpiry <= 0 {
		opts.PresignExpiry = 20 * time.Minute
	}
	loadOpts := []func(*awsconfig.LoadOptions) error{awsconfig.WithRegion(opts.Region)}
	if opts.AccessKey != "" {
		loadOpts = append(loadOpts, awsconfig.WithCredentialsProvider(
			credentials.NewStaticCredentialsProvider(opts.AccessKey, opts.SecretKey, "")))
	}
	cfg, err := awsconfig.LoadDefaultConfig(ctx, loadOpts...)
	if err != nil {
		return nil, fmt.Errorf("load aws config: %w", err)
	}
	client := awss3.NewFromConfig(cfg, func(o *awss3.Options) {
		if opts.Endpoint != "" {
			o.BaseEndpoint = aws.String(opts.Endpoint)
		}
		o.UsePathStyle = opts.ForcePathStyle
	})
	d := &Driver{client: client, presign: awss3.NewPresignClient(client), opts: opts}
	if _, err := client.HeadBucket(ctx, &awss3.HeadBucketInput{Bucket: aws.String(opts.Bucket)}); err != nil {
		return nil, fmt.Errorf("bucket %q not reachable: %w", opts.Bucket, err)
	}
	return d, nil
}

func (d *Driver) Name() string { return "s3" }

func (d *Driver) key(digest string) string { return storage.BlobPath(digest) }

func isNotFound(err error) bool {
	var nsk *types.NoSuchKey
	var nf *types.NotFound
	return errors.As(err, &nsk) || errors.As(err, &nf)
}

func (d *Driver) Get(ctx context.Context, digest string) (io.ReadCloser, int64, error) {
	out, err := d.client.GetObject(ctx, &awss3.GetObjectInput{
		Bucket: aws.String(d.opts.Bucket), Key: aws.String(d.key(digest)),
	})
	if err != nil {
		if isNotFound(err) {
			return nil, 0, storage.ErrNotFound
		}
		return nil, 0, err
	}
	return out.Body, aws.ToInt64(out.ContentLength), nil
}

// OpenRange implements storage.RangeReader with an HTTP Range on GetObject,
// so only the requested bytes leave the bucket. (With REDIRECT_GET the
// client fetches the presigned URL itself and sends its own Range header,
// which S3 honours — this path only serves non-redirected reads.)
func (d *Driver) OpenRange(ctx context.Context, digest string, offset, length int64) (io.ReadCloser, error) {
	if length == 0 {
		return io.NopCloser(bytes.NewReader(nil)), nil
	}
	out, err := d.client.GetObject(ctx, &awss3.GetObjectInput{
		Bucket: aws.String(d.opts.Bucket), Key: aws.String(d.key(digest)),
		Range: aws.String(fmt.Sprintf("bytes=%d-%d", offset, offset+length-1)),
	})
	if err != nil {
		if isNotFound(err) {
			return nil, storage.ErrNotFound
		}
		return nil, err
	}
	// Belt and braces: an endpoint that ignored the range (no Content-Range
	// on the reply) answered with the whole object — skip to the offset and
	// never hand out more than asked for.
	if out.ContentRange == nil {
		return storage.SkipAndLimit(out.Body, offset, length)
	}
	return storage.SkipAndLimit(out.Body, 0, length)
}

func (d *Driver) Stat(ctx context.Context, digest string) (int64, error) {
	out, err := d.client.HeadObject(ctx, &awss3.HeadObjectInput{
		Bucket: aws.String(d.opts.Bucket), Key: aws.String(d.key(digest)),
	})
	if err != nil {
		if isNotFound(err) {
			return 0, storage.ErrNotFound
		}
		return 0, err
	}
	return aws.ToInt64(out.ContentLength), nil
}

func (d *Driver) Put(ctx context.Context, digest string, r io.Reader, size int64) error {
	_, err := d.upload(ctx, d.key(digest), r, size)
	return err
}

// partSize is the multipart part size (and the largest body sent with a
// single PutObject).
const partSize = 8 << 20

// upload streams r into key and returns the byte count. When size >= 0 the
// count must match, otherwise nothing is published.
func (d *Driver) upload(ctx context.Context, key string, r io.Reader, size int64) (int64, error) {
	buf := make([]byte, partSize)
	n, err := io.ReadFull(r, buf)
	if err == io.EOF || err == io.ErrUnexpectedEOF {
		// The whole body fits in one part.
		if size >= 0 && int64(n) != size {
			return 0, fmt.Errorf("short write: got %d bytes, want %d", n, size)
		}
		_, err := d.client.PutObject(ctx, &awss3.PutObjectInput{
			Bucket:        aws.String(d.opts.Bucket),
			Key:           aws.String(key),
			Body:          bytes.NewReader(buf[:n]),
			ContentLength: aws.Int64(int64(n)),
			ContentType:   aws.String("application/octet-stream"),
		})
		return int64(n), err
	}
	if err != nil {
		return 0, err
	}

	created, err := d.client.CreateMultipartUpload(ctx, &awss3.CreateMultipartUploadInput{
		Bucket:      aws.String(d.opts.Bucket),
		Key:         aws.String(key),
		ContentType: aws.String("application/octet-stream"),
	})
	if err != nil {
		return 0, fmt.Errorf("create multipart upload: %w", err)
	}
	abort := func() {
		actx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		_, _ = d.client.AbortMultipartUpload(actx, &awss3.AbortMultipartUploadInput{
			Bucket: aws.String(d.opts.Bucket), Key: aws.String(key), UploadId: created.UploadId,
		})
	}
	var parts []types.CompletedPart
	var total int64
	for {
		// buf[:n] is the next part; err tells whether the body ended with it.
		num := int32(len(parts) + 1)
		out, uerr := d.client.UploadPart(ctx, &awss3.UploadPartInput{
			Bucket:        aws.String(d.opts.Bucket),
			Key:           aws.String(key),
			UploadId:      created.UploadId,
			PartNumber:    aws.Int32(num),
			Body:          bytes.NewReader(buf[:n]),
			ContentLength: aws.Int64(int64(n)),
		})
		if uerr != nil {
			abort()
			return 0, fmt.Errorf("upload part %d: %w", num, uerr)
		}
		parts = append(parts, types.CompletedPart{ETag: out.ETag, PartNumber: aws.Int32(num)})
		total += int64(n)
		if err != nil {
			break // io.EOF / io.ErrUnexpectedEOF: that was the last part
		}
		n, err = io.ReadFull(r, buf)
		if err != nil && !errors.Is(err, io.EOF) && !errors.Is(err, io.ErrUnexpectedEOF) {
			abort()
			return 0, err
		}
		if n == 0 {
			break // the body ended exactly on a part boundary
		}
	}
	if size >= 0 && total != size {
		abort()
		return 0, fmt.Errorf("short write: got %d bytes, want %d", total, size)
	}
	if _, err := d.client.CompleteMultipartUpload(ctx, &awss3.CompleteMultipartUploadInput{
		Bucket:          aws.String(d.opts.Bucket),
		Key:             aws.String(key),
		UploadId:        created.UploadId,
		MultipartUpload: &types.CompletedMultipartUpload{Parts: parts},
	}); err != nil {
		abort()
		return 0, fmt.Errorf("complete multipart upload: %w", err)
	}
	return total, nil
}

func (d *Driver) Delete(ctx context.Context, digest string) error {
	_, err := d.client.DeleteObject(ctx, &awss3.DeleteObjectInput{
		Bucket: aws.String(d.opts.Bucket), Key: aws.String(d.key(digest)),
	})
	if err != nil && !isNotFound(err) {
		return err
	}
	return nil
}

func (d *Driver) RedirectURL(ctx context.Context, digest string) (string, error) {
	if !d.opts.RedirectGET {
		return "", nil
	}
	req, err := d.presign.PresignGetObject(ctx, &awss3.GetObjectInput{
		Bucket: aws.String(d.opts.Bucket), Key: aws.String(d.key(digest)),
	}, awss3.WithPresignExpires(d.opts.PresignExpiry))
	if err != nil {
		return "", err
	}
	return req.URL, nil
}

// --- storage.ObjectStore: arbitrary keys in the bucket (shared staging) ---

func (d *Driver) PutObject(ctx context.Context, key string, r io.Reader, size int64) (int64, error) {
	if !storage.ValidObjectKey(key) {
		return 0, fmt.Errorf("invalid object key %q", key)
	}
	return d.upload(ctx, key, r, size)
}

func (d *Driver) GetObject(ctx context.Context, key string) (io.ReadCloser, int64, error) {
	out, err := d.client.GetObject(ctx, &awss3.GetObjectInput{
		Bucket: aws.String(d.opts.Bucket), Key: aws.String(key),
	})
	if err != nil {
		if isNotFound(err) {
			return nil, 0, storage.ErrNotFound
		}
		return nil, 0, err
	}
	size := int64(-1)
	if out.ContentLength != nil {
		size = *out.ContentLength
	}
	return out.Body, size, nil
}

func (d *Driver) DeleteObject(ctx context.Context, key string) error {
	_, err := d.client.DeleteObject(ctx, &awss3.DeleteObjectInput{
		Bucket: aws.String(d.opts.Bucket), Key: aws.String(key),
	})
	if err != nil && !isNotFound(err) {
		return err
	}
	return nil
}

func (d *Driver) ListObjects(ctx context.Context, prefix string) ([]storage.ObjectInfo, error) {
	var out []storage.ObjectInfo
	pages := awss3.NewListObjectsV2Paginator(d.client, &awss3.ListObjectsV2Input{
		Bucket: aws.String(d.opts.Bucket), Prefix: aws.String(prefix),
	})
	for pages.HasMorePages() {
		page, err := pages.NextPage(ctx)
		if err != nil {
			return nil, err
		}
		for _, o := range page.Contents {
			info := storage.ObjectInfo{Key: aws.ToString(o.Key), Size: aws.ToInt64(o.Size)}
			if o.LastModified != nil {
				info.ModTime = *o.LastModified
			}
			out = append(out, info)
		}
	}
	return out, nil
}

// Describe implements storage.Describer: the bucket and, when set, the
// endpoint — never the credentials.
func (d *Driver) Describe() string {
	if d.opts.Endpoint != "" {
		return "s3 bucket " + d.opts.Bucket + " at " + d.opts.Endpoint
	}
	return "s3 bucket " + d.opts.Bucket + " (" + d.opts.Region + ")"
}

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

// Driver stores blobs as objects in a bucket. Uploads are staged locally and
// committed with a single streaming PutObject, so no multipart bookkeeping is
// required and partial uploads never pollute the bucket.
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
	_, err := d.client.PutObject(ctx, &awss3.PutObjectInput{
		Bucket:        aws.String(d.opts.Bucket),
		Key:           aws.String(d.key(digest)),
		Body:          r,
		ContentLength: aws.Int64(size),
		ContentType:   aws.String("application/octet-stream"),
	})
	return err
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

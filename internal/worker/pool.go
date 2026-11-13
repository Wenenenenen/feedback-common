package worker

import (
	"context"
	"log"
	"sync"
	"time"

	"vod-hls-server/internal/model"
	"vod-hls-server/internal/store"
	"vod-hls-server/internal/util"
)

// pollInterval 队列空闲时的轮询间隔，避免空转打满 CPU 又保证任务能被及时认领。
const pollInterval = 1500 * time.Millisecond

// Pool 用带缓冲信号量控制同时运行的 ffmpeg 数量；单调度循环认领任务，执行交给独立 goroutine。
type Pool struct {
	store  *store.Store
	runner *Runner
	// sem 容量等于转码并发上限，拿到令牌才允许认领并执行任务
	sem chan struct{}
	// taskWG 只跟踪实际执行转码的 goroutine，供优雅关停等待收尾
	taskWG sync.WaitGroup
	// loopDone 调度循环自身退出信号
	loopDone chan struct{}

	workerID string // 本进程标识，写入 jobs.worker_id 便于排查
}

// NewPool 创建转码池；concurrency 为同时执行的 ffmpeg 上限。
func NewPool(st *store.Store, runner *Runner, concurrency int) *Pool {
	id, _ := util.NewUUID()
	return &Pool{
		store:    st,
		runner:   runner,
		sem:      make(chan struct{}, concurrency),
		loopDone: make(chan struct{}),
		workerID: id,
	}
}

// Start 启动后台调度循环。
func (p *Pool) Start(ctx context.Context) {
	go p.loop(ctx)
	log.Printf("转码调度池已启动，worker=%s", p.workerID)
}

// Wait 阻塞直到调度循环退出且所有在跑任务收尾，配合根 context 取消实现优雅关停。
func (p *Pool) Wait() {
	<-p.loopDone
	p.taskWG.Wait()
}

// loop 单调度循环：拿令牌 -> 认领任务 -> 异步执行；空闲或满载时按固定间隔轮询。
func (p *Pool) loop(ctx context.Context) {
	defer close(p.loopDone)
	for {
		if ctx.Err() != nil {
			return
		}

		// 先占并发名额，占不到说明 ffmpeg 已跑满，阻塞等待名额释放或关停
		select {
		case p.sem <- struct{}{}:
		case <-ctx.Done():
			return
		}

		job, err := p.store.ClaimNext(ctx, p.workerID, 0)
		if err != nil {
			log.Printf("认领任务出错: %v", err)
			<-p.sem // 认领出错也要释放名额
			if !sleep(ctx, pollInterval) {
				return
			}
			continue
		}
		if job == nil {
			// 队列空闲：释放名额并休眠后再试
			<-p.sem
			if !sleep(ctx, pollInterval) {
				return
			}
			continue
		}

		// 领到任务，独立 goroutine 执行，主循环立刻回去尝试占下一个名额
		p.taskWG.Add(1)
		go func(j *model.Job) {
			defer p.taskWG.Done()
			defer func() { <-p.sem }()
			p.execute(ctx, j)
		}(job)
	}
}

// execute 运行单个任务并把成功/失败结果落库；panic 也要兜底成 failed，防止 goroutine 崩溃拖垮进程。
func (p *Pool) execute(ctx context.Context, job *model.Job) {
	defer func() {
		if rec := recover(); rec != nil {
			log.Printf("转码 goroutine 异常 job=%s: %v", job.ID, rec)
			_ = p.store.MarkJobFailed(ctx, job.ID, "转码进程异常崩溃", "")
			_ = p.store.UpdateVideoStatus(ctx, job.VideoID, model.VideoStatusFailed, "转码进程异常崩溃")
		}
	}()

	log.Printf("开始转码任务 job=%s video=%s attempt=%d", job.ID, job.VideoID, job.Attempt)
	err := p.runner.Run(ctx, job)
	if err == nil {
		log.Printf("转码完成 job=%s video=%s", job.ID, job.VideoID)
		return
	}

	// 服务关停导致的取消不算失败：重启恢复逻辑会把 processing 任务重新入队
	if ctx.Err() != nil {
		log.Printf("任务因服务关停中断 job=%s: %v", job.ID, err)
		return
	}
	log.Printf("转码失败 job=%s video=%s: %v", job.ID, job.VideoID, err)
	if ferr := p.store.MarkJobFailed(ctx, job.ID, err.Error(), ""); ferr != nil {
		log.Printf("写入任务失败状态出错 job=%s: %v", job.ID, ferr)
	}
	if verr := p.store.UpdateVideoStatus(ctx, job.VideoID, model.VideoStatusFailed, err.Error()); verr != nil {
		log.Printf("写入视频失败状态出错 video=%s: %v", job.VideoID, verr)
	}
}

// sleep 在 ctx 取消时提前唤醒，返回 false 表示应退出。
func sleep(ctx context.Context, d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}
